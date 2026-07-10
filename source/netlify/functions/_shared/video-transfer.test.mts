import assert from "node:assert/strict";
import test from "node:test";

import {
  default as videoTransferHandler,
  maxProxyUploadBytes,
  validateProxyUploadRequest,
  validateFinalizePayload,
  validateUploadSessionPayload,
} from "../video-transfer.mts";

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

test("proxy endpoint requires admin before upload handling", async () => {
  const response = await videoTransferHandler(new Request("https://example.test/api/video-transfer/saved-video-1/upload", {
    method: "PUT",
    body: new Blob(["video-bytes"], { type: "video/mp4" }),
  }));
  const body = await response.json() as any;

  assert.equal(response.status, 401);
  assert.equal(body.error, "unauthorized");
});

test("proxy upload validation rejects missing expired and oversized sessions", () => {
  assert.throws(
    () => validateProxyUploadRequest(null, { accountId: "account-1", savedVideoId: "saved-video-1" }),
    /new upload session/i,
  );
  assert.throws(
    () => validateProxyUploadRequest({
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      expectedSizeBytes: 10,
      expiresAt: "2026-07-10T00:00:00.000Z",
      status: "uploading",
    }, { accountId: "account-1", savedVideoId: "saved-video-1", now: new Date("2026-07-10T00:01:00.000Z") }),
    /new upload session/i,
  );
  assert.throws(
    () => validateProxyUploadRequest({
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      expectedSizeBytes: maxProxyUploadBytes + 1,
      expiresAt: "2026-07-10T01:00:00.000Z",
      status: "uploading",
    }, { accountId: "account-1", savedVideoId: "saved-video-1", now: new Date("2026-07-10T00:00:00.000Z") }),
    /too large/i,
  );
});

test("proxy upload validation enforces account saved-video ownership and size", () => {
  const session = {
    accountId: "account-1",
    savedVideoId: "saved-video-1",
    expectedSizeBytes: 10,
    expiresAt: "2026-07-10T01:00:00.000Z",
    status: "uploading" as const,
  };

  assert.throws(
    () => validateProxyUploadRequest(session, {
      accountId: "account-2",
      savedVideoId: "saved-video-1",
      contentLength: 10,
      now: new Date("2026-07-10T00:00:00.000Z"),
    }),
    /ownership metadata/i,
  );
  assert.throws(
    () => validateProxyUploadRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      contentLength: 11,
      now: new Date("2026-07-10T00:00:00.000Z"),
    }),
    /size did not match/i,
  );
  assert.equal(
    validateProxyUploadRequest(session, {
      accountId: "account-1",
      savedVideoId: "saved-video-1",
      contentLength: 10,
      now: new Date("2026-07-10T00:00:00.000Z"),
    }).savedVideoId,
    "saved-video-1",
  );
});
