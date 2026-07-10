import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VideoAnalysis } from "../models/Analysis";
import type { PlayerVideo } from "../models/Video";
import type { ComparisonWorkspaceState } from "./localPersistence";
import {
  SavedVideoLibraryError,
  createMemorySavedVideoLibraryStore,
  getSavedVideoCloudStatus,
  saveSavedVideoToCloud,
} from "./savedVideoLibrary";

const workspaceSnapshot: ComparisonWorkspaceState = {
  version: 1,
  mode: "single",
  activeSide: "left",
  savedVideoIds: {},
  linkedPlayback: false,
  focusWindowOpen: false,
  focusWindowMode: "area",
  focusWindowSide: "left",
  focusAreaRect: null,
};

const video: PlayerVideo = {
  id: "transient-left",
  playerId: "player-1",
  lessonId: "lesson-1",
  sourceUrl: "blob:transient",
  title: "swing.mp4",
  createdAt: "2026-07-10T00:00:00.000Z",
  duration: 12,
  width: 1280,
  height: 720,
};

const analysisSnapshot: VideoAnalysis = {
  id: "analysis-1",
  playerId: "player-1",
  lessonId: "lesson-1",
  videoId: "transient-left",
  videoMeta: {
    title: "swing.mp4",
    duration: 12,
    width: 1280,
    height: 720,
  },
  drawings: [],
  markers: [],
  notes: [],
  focusViews: [],
  focusSnapshots: [],
  narrationRefs: [],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const sourceBlob = () => new Blob(["video-bytes"], { type: "video/mp4" });

describe("saved video library", () => {
  it("creates a saved video item with blob keyed by savedVideoId", async () => {
    const store = createMemorySavedVideoLibraryStore();
    const item = await store.saveItem({
      playerId: "player-1",
      lessonId: "lesson-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: sourceBlob(),
      analysisSnapshot,
      workspaceSnapshot,
    });

    assert.match(item.savedVideoId, /^saved-video-/);
    assert.equal(item.local.status, "available");
    assert.equal(item.local.blobRecordId, item.savedVideoId);
    assert.equal(item.workspaceSnapshot.savedVideoIds?.left, item.savedVideoId);
    assert.equal((await store.getBlob(item.savedVideoId))?.size, sourceBlob().size);
  });

  it("updates an existing saved item instead of duplicating it", async () => {
    const store = createMemorySavedVideoLibraryStore();
    const first = await store.saveItem({
      playerId: "player-1",
      lessonId: "lesson-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: sourceBlob(),
      analysisSnapshot,
      workspaceSnapshot,
    });
    const second = await store.saveItem({
      savedVideoId: first.savedVideoId,
      playerId: "player-1",
      lessonId: "lesson-1",
      title: "Updated title",
      sourceSide: "left",
      sourceVideo: { ...video, title: "updated.mp4" },
      sourceBlob: new Blob(["updated-video-bytes"], { type: "video/mp4" }),
      analysisSnapshot: {
        ...analysisSnapshot,
        drawings: [{
          id: "draw-1",
          type: "line",
          color: "#fff",
          strokeWidth: 2,
          opacity: 1,
          layer: 0,
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1,
        }],
      },
      workspaceSnapshot,
    });

    assert.equal(second.savedVideoId, first.savedVideoId);
    assert.equal(second.title, "Updated title");
    assert.equal((await store.listItems()).length, 1);
    assert.equal((await store.getBlob(first.savedVideoId))?.size, "updated-video-bytes".length);
  });

  it("keeps saved blobs independent from transient slot cleanup", async () => {
    const store = createMemorySavedVideoLibraryStore();
    const transientSlots = new Map<string, Blob>([["player-1.default.left", sourceBlob()]]);
    const item = await store.saveItem({
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: transientSlots.get("player-1.default.left") as Blob,
      analysisSnapshot,
      workspaceSnapshot,
    });

    transientSlots.delete("player-1.default.left");

    assert.equal(transientSlots.has("player-1.default.left"), false);
    assert.equal((await store.getBlob(item.savedVideoId))?.size, sourceBlob().size);
  });

  it("deletes saved metadata and blob together", async () => {
    const store = createMemorySavedVideoLibraryStore();
    const item = await store.saveItem({
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: sourceBlob(),
      analysisSnapshot,
      workspaceSnapshot,
    });

    await store.deleteItem(item.savedVideoId);

    assert.equal(await store.getItem(item.savedVideoId), null);
    assert.equal(await store.getBlob(item.savedVideoId), null);
  });

  it("keeps metadata visible when a blob is missing", async () => {
    const store = createMemorySavedVideoLibraryStore();
    const item = await store.saveItem({
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: sourceBlob(),
      analysisSnapshot,
      workspaceSnapshot,
    });
    await store.putItem({
      ...item,
      savedVideoId: "metadata-only",
      local: { status: "missing" },
    });

    assert.equal((await store.getItem("metadata-only"))?.local.status, "missing");
    await assert.rejects(
      () => store.verifyItem("metadata-only"),
      (error) =>
        error instanceof SavedVideoLibraryError &&
        error.code === "SAVED_VIDEO_BLOB_MISSING"
    );
  });

  it("lists player profile videos from saved items", async () => {
    const store = createMemorySavedVideoLibraryStore();
    await store.saveItem({
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: sourceBlob(),
      analysisSnapshot,
      workspaceSnapshot,
    });
    await store.saveItem({
      playerId: "other-player",
      sourceSide: "left",
      sourceVideo: { ...video, playerId: "other-player" },
      sourceBlob: sourceBlob(),
      analysisSnapshot: { ...analysisSnapshot, playerId: "other-player" },
      workspaceSnapshot,
    });

    const playerItems = await store.listItemsForPlayer("player-1");

    assert.equal(playerItems.length, 1);
    assert.equal(playerItems[0].playerId, "player-1");
  });

  it("migrates a transient record by copying the blob and preserving the original record", async () => {
    const store = createMemorySavedVideoLibraryStore();
    const transientRecord = {
      slotKey: "player-1.lesson-1.left",
      video,
      blob: sourceBlob(),
    };
    const item = await store.migrateTransientVideo({
      storedVideo: transientRecord,
      sourceSide: "left",
      analysisSnapshot,
      workspaceSnapshot,
    });

    assert.equal(transientRecord.blob.size, sourceBlob().size);
    assert.equal((await store.getBlob(item.savedVideoId))?.size, transientRecord.blob.size);
  });

  it("requires durable metadata before starting a Drive upload", async () => {
    const store = createMemorySavedVideoLibraryStore();

    await assert.rejects(
      () => saveSavedVideoToCloud("missing-video", store),
      (error) =>
        error instanceof SavedVideoLibraryError &&
        error.code === "SAVED_VIDEO_METADATA_MISSING"
    );
  });

  it("tracks ready cloud transfer metadata without deleting the local blob", async () => {
    const store = createMemorySavedVideoLibraryStore();
    const item = await store.saveItem({
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: sourceBlob(),
      analysisSnapshot,
      workspaceSnapshot,
    });

    await store.putItem({
      ...item,
      cloud: {
        status: "ready",
        provider: "google-drive",
        driveAssetId: "drive-folder-1",
        driveFolderId: "drive-folder-1",
        driveVideoFileId: "drive-video-1",
        driveManifestFileId: "drive-manifest-1",
        driveAnalysisFileId: "drive-analysis-1",
        uploadedAt: "2026-07-10T01:00:00.000Z",
      },
    });

    const ready = await store.getItem(item.savedVideoId);
    assert.equal(getSavedVideoCloudStatus(ready).status, "ready");
    assert.equal((await store.getBlob(item.savedVideoId))?.size, sourceBlob().size);
  });
});
