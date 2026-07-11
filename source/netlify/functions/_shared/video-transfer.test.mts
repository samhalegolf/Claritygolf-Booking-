import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultChunkSizeBytes,
  default as videoTransferHandler,
  googleChunkGranularityBytes,
  maxChunkSizeBytes,
  publicTransferSession,
  validateChunkRequest,
  validateFinalizePayload,
  validateUploadSessionPayload,
} from "../video-transfer.mts";

const netlifyBufferedPayloadLimitBytes = 6 * 1024 * 1024;

test("chunk size stays under Netlify's 6 MB buffered payload limit and on Google's 256 KB granularity", () => {
  assert.ok(defaultChunkSizeBytes < netlifyBufferedPayloadLimitBytes, "chunks must fit inside Netlify's buffered request body limit");
  assert.equal(defaultChunkSizeBytes % googleChunkGranularityBytes, 0, "chunks must align to Google's 256 KB resumable granularity");
  assert.equal(maxChunkSizeBytes, defaultChunkSizeBytes);
});

const compactPayload = {
  savedVideoId: "saved-video-1",
  playerId: "player-1",
  lessonId: "lesson-1",
  analysisId: "analysis-1",
  title: "Player Name - 10 Jul 26 6:34 PM",
  createdAt: "2026-07-10T08:34:00.000Z",
  updatedAt: "2026-07-10T08:34:00.000Z",
  video: {
    fileName: "swing.mp4",
    mimeType: "video/mp4",
    sizeBytes: 12345,
    checksumSha256: "a".repeat(64),
  },
};

test("upload-session accepts compact ownership and video metadata", () => {
  const { savedVideo, video } = validateUploadSessionPayload(compactPayload);

  assert.equal(savedVideo.savedVideoId, "saved-video-1");
  assert.equal(savedVideo.playerId, "player-1");
  assert.equal(savedVideo.analysisId, "analysis-1");
  assert.equal(video.sizeBytes, 12345);
  assert.equal(video.checksumSha256, "a".repeat(64));
});

test("upload-session validation ignores heavy saved-video fields", () => {
  const { savedVideo } = validateUploadSessionPayload({
    ...compactPayload,
    analysisSnapshot: { markers: [{ thumbnail: "data:image/png;base64,abc" }] },
    workspaceSnapshot: { preview: "data:image/png;base64,def" },
    thumbnailDataUrl: "data:image/png;base64,ghi",
  });

  assert.equal("analysisSnapshot" in savedVideo, false);
  assert.equal("workspaceSnapshot" in savedVideo, false);
  assert.equal("thumbnailDataUrl" in savedVideo, false);
});

test("upload-session requires ownership metadata and video checksum", () => {
  assert.throws(
    () => validateUploadSessionPayload({ ...compactPayload, playerId: "" }),
    /ownership metadata is required/i,
  );
  assert.throws(
    () => validateUploadSessionPayload({ ...compactPayload, video: { ...compactPayload.video, checksumSha256: "bad" } }),
    /checksum is required/i,
  );
});

test("finalize accepts compact analysis JSON and strips accidental data URLs", () => {
  const { savedVideo, video, analysisJson } = validateFinalizePayload({
    ...compactPayload,
    video: {
      ...compactPayload.video,
      driveFileId: "drive-video-1",
    },
    analysisJson: {
      savedVideoId: "saved-video-1",
      analysis: {
        drawings: [{ id: "draw-1", type: "line", x1: 0, y1: 0, x2: 1, y2: 1 }],
        markers: [{ id: "marker-1", label: "Impact", time: 1.2, thumbnail: "data:image/png;base64,abc" }],
        focusSnapshots: [{ id: "focus-1", currentTime: 1.2, cropRect: { x: 0, y: 0, width: 1, height: 1 }, imageDataUrl: "data:image/png;base64,def" }],
      },
      workspace: { mode: "single", preview: "data:image/png;base64,ghi" },
    },
  }, "saved-video-1");

  const serialized = JSON.stringify(analysisJson);
  assert.equal(savedVideo.savedVideoId, "saved-video-1");
  assert.equal(video.driveFileId, "drive-video-1");
  assert.equal(serialized.includes("data:image"), false);
  assert.equal((analysisJson.analysis as any).drawings[0].id, "draw-1");
  assert.equal((analysisJson.analysis as any).markers[0].time, 1.2);
  assert.equal((analysisJson.analysis as any).focusSnapshots[0].cropRect.width, 1);
});

test("chunk endpoint requires admin before upload handling", async () => {
  const response = await videoTransferHandler(new Request("https://example.test/api/video-transfer/saved-video-1/chunk", {
    method: "PUT",
    body: new Blob(["video-bytes"], { type: "video/mp4" }),
  }));
  const body = await response.json() as any;

  assert.equal(response.status, 401);
  assert.equal(body.error, "unauthorized");
});

test("public transfer session never exposes the Google resumable URL", () => {
  const publicSession = publicTransferSession({
    version: 1,
    transferId: "transfer-1",
    savedVideoId: "saved-video-1",
    accountId: "account-1",
    providerId: "google-drive",
    catalogueStatus: "uploading",
    playerId: "player-1",
    analysisId: "analysis-1",
    status: "uploading",
    expectedSizeBytes: 10,
    checksumSha256: "a".repeat(64),
    acceptedOffsetBytes: 4,
    chunkSizeBytes: defaultChunkSizeBytes,
    driveAssetFolderId: "folder-1",
    resumableSessionUrl: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&secret=1",
    resumableSessionCreatedAt: "2026-07-10T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  });

  const serialized = JSON.stringify(publicSession);
  assert.equal(serialized.includes("googleapis.com"), false);
  assert.equal(serialized.includes("resumableSessionUrl"), false);
  assert.equal(publicSession.acceptedOffsetBytes, 4);
});

test("chunk validation rejects out-of-order overlapping and oversized chunks", () => {
  const session = {
    accountId: "account-1",
    savedVideoId: "saved-video-1",
    status: "uploading" as const,
    acceptedOffsetBytes: 4,
    expectedSizeBytes: 20,
    chunkSizeBytes: 8,
  };

  assert.throws(
    () => validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 0,
      endByte: 3,
      totalSize: 20,
      chunkLength: 4,
    }),
    /accepted transfer offset/i,
  );
  assert.throws(
    () => validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 4,
      endByte: 14,
      totalSize: 20,
      chunkLength: 11,
    }),
    /chunk size/i,
  );
  assert.throws(
    () => validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 4,
      endByte: 9,
      totalSize: 21,
      chunkLength: 6,
    }),
    /total size/i,
  );

  assert.equal(
    validateChunkRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      startByte: 4,
      endByte: 11,
      totalSize: 20,
      chunkLength: 8,
    }),
    true,
  );
});
