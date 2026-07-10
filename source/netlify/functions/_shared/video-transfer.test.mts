import assert from "node:assert/strict";
import test from "node:test";

import {
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

