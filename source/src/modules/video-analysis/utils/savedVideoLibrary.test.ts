import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VideoAnalysis } from "../models/Analysis";
import type { PlayerVideo } from "../models/Video";
import type { ComparisonWorkspaceState } from "./localPersistence";
import {
  SavedVideoCloudError,
  SavedVideoLibraryError,
  buildVideoUploadSessionRequest,
  compactSavedVideoAnalysisJson,
  createMemorySavedVideoLibraryStore,
  getManagedLocalVideoLibraryStatus,
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

const dataUrl = (label: string) => `data:image/png;base64,${Buffer.from(label).toString("base64")}`;

const stringifySize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const installBrowserGlobals = () => {
  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: { getItem: () => "device-1" },
      navigator: { userAgent: "node-test", platform: "test-platform" },
    },
    configurable: true,
  });
};

const installMockXhr = (
  handler: (request: { method: string; url: string; headers: Record<string, string>; body: Blob }) => {
    status: number;
    body?: unknown;
    contentType?: string;
  }
) => {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: Blob }> = [];
  class MockXhr {
    method = "";
    url = "";
    status = 0;
    responseText = "";
    headers: Record<string, string> = {};
    responseContentType = "application/json";
    upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
    onload?: () => void;
    onerror?: () => void;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    }

    getResponseHeader(key: string) {
      return key.toLowerCase() === "content-type" ? this.responseContentType : "";
    }

    send(body: Blob) {
      requests.push({ method: this.method, url: this.url, headers: this.headers, body });
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
      const response = handler({ method: this.method, url: this.url, headers: this.headers, body });
      this.status = response.status;
      this.responseContentType = response.contentType || "application/json";
      this.responseText = typeof response.body === "string" ? response.body : JSON.stringify(response.body || {});
      this.onload?.();
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { value: MockXhr, configurable: true });
  return requests;
};

const savedVideoWithLargeImages = async () => {
  const store = createMemorySavedVideoLibraryStore();
  const item = await store.saveItem({
    playerId: "player-1",
    lessonId: "lesson-1",
    sourceSide: "left",
    sourceVideo: video,
    sourceBlob: sourceBlob(),
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
      markers: Array.from({ length: 120 }, (_, index) => ({
        id: `marker-${index}`,
        label: "Impact" as const,
        time: index / 10,
        color: "#f00",
        thumbnail: dataUrl(`marker-${index}`.repeat(200)),
      })),
      focusSnapshots: [{
        id: "focus-1",
        playerId: "player-1",
        analysisId: "analysis-1",
        title: "Focus",
        side: "left",
        currentTime: 1.25,
        currentFrame: 38,
        cropRect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        imageDataUrl: dataUrl("focus".repeat(200)),
        createdAt: "2026-07-10T00:00:00.000Z",
      }],
    },
    workspaceSnapshot,
    thumbnailDataUrl: dataUrl("poster".repeat(200)),
  });
  return { store, item };
};

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

  it("reports local-cache recovery mode when File System Access is unavailable", async () => {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });

    const status = await getManagedLocalVideoLibraryStatus();

    assert.equal(status.supported, false);
    assert.equal(status.configured, false);
    assert.equal(status.health, "unsupported");
    assert.match(status.message, /local cache/i);
  });

  it("keeps managed-library metadata on the saved item while retaining the cache blob", async () => {
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
      local: {
        ...item.local,
        managed: {
          status: "healthy",
          libraryId: "clarity-video-library-test",
          migratedAt: "2026-07-10T00:00:00.000Z",
          verifiedAt: "2026-07-10T00:01:00.000Z",
        },
      },
    });

    const ready = await store.verifyItem(item.savedVideoId);

    assert.equal(ready.local.managed?.status, "healthy");
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

  it("builds an upload-session payload without embedded data URLs", async () => {
    const { item } = await savedVideoWithLargeImages();
    const payload = buildVideoUploadSessionRequest(item, sourceBlob(), "a".repeat(64), {
      deviceId: "device-1",
      deviceName: "Test Browser",
      platform: "test-platform",
    });
    const serialized = JSON.stringify(payload);

    assert.equal(serialized.includes("data:image"), false);
    assert.equal("analysisSnapshot" in payload, false);
    assert.equal("workspaceSnapshot" in payload, false);
    assert.equal("thumbnailDataUrl" in payload, false);
    assert.equal(payload.savedVideoId, item.savedVideoId);
    assert.equal(payload.playerId, "player-1");
    assert.equal(payload.analysisId, "analysis-1");
    assert.equal(payload.video.checksumSha256, "a".repeat(64));
  });

  it("keeps upload-session payload small even with many marker thumbnails", async () => {
    const { item } = await savedVideoWithLargeImages();
    const fullSavedVideoSize = stringifySize(item);
    const payload = buildVideoUploadSessionRequest(item, sourceBlob(), "b".repeat(64));

    assert.ok(fullSavedVideoSize > 250_000);
    assert.ok(stringifySize(payload) < 1_500);
  });

  it("compacts analysis JSON while preserving editable drawings and marker timestamps", async () => {
    const { item } = await savedVideoWithLargeImages();
    const compact = compactSavedVideoAnalysisJson(item);
    const serialized = JSON.stringify(compact);

    assert.equal(serialized.includes("data:image"), false);
    assert.equal(compact.analysis.drawings[0]?.id, "draw-1");
    assert.equal(compact.analysis.markers[0]?.time, 0);
    assert.equal("thumbnail" in compact.analysis.markers[0], false);
    assert.equal(compact.analysis.focusSnapshots[0]?.currentTime, 1.25);
    assert.deepEqual(compact.analysis.focusSnapshots[0]?.cropRect, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    assert.equal("imageDataUrl" in compact.analysis.focusSnapshots[0], false);
  });

  it("reports non-JSON upload-session failures with status, type, and safe preview", async () => {
    installBrowserGlobals();
    const originalFetch = globalThis.fetch;
    try {
      for (const status of [413, 404, 500]) {
        const { store, item } = await savedVideoWithLargeImages();
        globalThis.fetch = async () =>
          new Response(`<html>failed token=secret-value status ${status}</html>`, {
            status,
            headers: { "content-type": "text/html" },
          });
        await assert.rejects(
          () => saveSavedVideoToCloud(item.savedVideoId, store),
          (error) =>
            error instanceof SavedVideoCloudError &&
            error.code === "DRIVE_UPLOAD_SESSION_FAILED" &&
            error.status === status &&
            error.message.includes(`HTTP ${status}, text/html`) &&
            error.message.includes("token=[redacted]") &&
            !error.message.includes("secret-value")
        );
        const local = await store.getItem(item.savedVideoId);
        assert.equal(local?.local.status, "available");
        assert.equal(local?.thumbnailDataUrl, item.thumbnailDataUrl);
        assert.equal(local?.analysisSnapshot.markers[0]?.thumbnail, item.analysisSnapshot.markers[0]?.thumbnail);
        assert.equal((await store.getBlob(item.savedVideoId))?.size, sourceBlob().size);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends only compact ownership metadata to upload-session", async () => {
    installBrowserGlobals();
    const { store, item } = await savedVideoWithLargeImages();
    const originalFetch = globalThis.fetch;
    let uploadSessionBody = "";
    globalThis.fetch = async (input, init) => {
      if (String(input).includes(`/api/video-transfer/${encodeURIComponent(item.savedVideoId)}/session`)) {
        uploadSessionBody = String(init?.body || "");
        return Response.json({
          ok: true,
          status: "ready",
          session: {
            transferId: "transfer-1",
            savedVideoId: item.savedVideoId,
            status: "ready",
            expectedSizeBytes: sourceBlob().size,
            acceptedOffsetBytes: sourceBlob().size,
            chunkSizeBytes: 8 * 1024 * 1024,
            driveAssetFolderId: "drive-folder-1",
            driveManifestFileId: "manifest-1",
          },
        });
      }
      return Response.json({ ok: false }, { status: 500 });
    };
    try {
      await saveSavedVideoToCloud(item.savedVideoId, store);
      const payload = JSON.parse(uploadSessionBody);
      assert.equal(uploadSessionBody.includes("data:image"), false);
      assert.equal(payload.savedVideoId, item.savedVideoId);
      assert.equal(payload.playerId, item.playerId);
      assert.equal(payload.analysisId, item.analysisId);
      assert.equal(payload.video.sizeBytes, sourceBlob().size);
      assert.equal("analysisSnapshot" in payload, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uploads saved video chunks to same-origin Clarity endpoint and never to googleapis", async () => {
    installBrowserGlobals();
    const { store, item } = await savedVideoWithLargeImages();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method, body: init?.body });
      if (String(input).includes(`/api/video-transfer/${encodeURIComponent(item.savedVideoId)}/session`)) {
        return Response.json({
          ok: true,
          status: "uploading",
          session: {
            transferId: "transfer-1",
            savedVideoId: item.savedVideoId,
            status: "uploading",
            expectedSizeBytes: sourceBlob().size,
            acceptedOffsetBytes: 0,
            chunkSizeBytes: 4,
            driveAssetFolderId: "drive-folder-1",
          },
        });
      }
      if (String(input).includes(`/api/video-transfer/${encodeURIComponent(item.savedVideoId)}/chunk`)) {
        const body = init?.body as Blob;
        const start = Number((init?.headers as Record<string, string>)["X-Clarity-Start-Byte"]);
        return Response.json({
          ok: true,
          status: start + body.size >= sourceBlob().size ? "verifying" : "uploading",
          session: {
            transferId: "transfer-1",
            savedVideoId: item.savedVideoId,
            status: start + body.size >= sourceBlob().size ? "verifying" : "uploading",
            expectedSizeBytes: sourceBlob().size,
            acceptedOffsetBytes: start + body.size,
            chunkSizeBytes: 4,
            driveAssetFolderId: "drive-folder-1",
            driveVideoFileId: start + body.size >= sourceBlob().size ? "drive-video-1" : undefined,
          },
        });
      }
      if (String(input).includes(`/api/video-transfer/${encodeURIComponent(item.savedVideoId)}/finalize`)) {
        assert.equal(init?.method, "POST");
        const payload = JSON.parse(String(init?.body || "{}"));
        assert.equal(payload.video.driveFileId, "drive-video-1");
        return Response.json({
          ok: true,
          status: "ready",
          assetFolderId: "drive-folder-1",
          videoFileId: "drive-video-1",
          manifestFileId: "manifest-1",
          analysisFileId: "analysis-1",
          uploadedAt: "2026-07-10T01:00:00.000Z",
        });
      }
      return Response.json({ ok: false }, { status: 500 });
    };
    try {
      const ready = await saveSavedVideoToCloud(item.savedVideoId, store);

      const chunkRequests = requests.filter((request) => request.url.includes("/chunk"));
      assert.ok(chunkRequests.length > 1);
      assert.equal(chunkRequests.every((request) => request.method === "PUT"), true);
      assert.equal(chunkRequests.every((request) => (request.body as Blob).size <= 4), true);
      assert.equal(requests.some((request) => request.url.includes("googleapis.com")), false);
      assert.equal(ready.cloud?.status, "ready");
      assert.equal((await store.getBlob(item.savedVideoId))?.size, sourceBlob().size);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not finalize after a failed proxy upload and keeps the local saved blob", async () => {
    installBrowserGlobals();
    const { store, item } = await savedVideoWithLargeImages();
    const originalFetch = globalThis.fetch;
    const fetchUrls: string[] = [];
    globalThis.fetch = async (input) => {
      fetchUrls.push(String(input));
      if (String(input).includes(`/api/video-transfer/${encodeURIComponent(item.savedVideoId)}/session`)) {
        return Response.json({
          ok: true,
          status: "uploading",
          session: {
            transferId: "transfer-1",
            savedVideoId: item.savedVideoId,
            status: "uploading",
            expectedSizeBytes: sourceBlob().size,
            acceptedOffsetBytes: 0,
            chunkSizeBytes: 4,
            driveAssetFolderId: "drive-folder-1",
          },
        });
      }
      if (String(input).includes(`/api/video-transfer/${encodeURIComponent(item.savedVideoId)}/chunk`)) {
        return Response.json(
          { ok: false, error: "DRIVE_UPLOAD_PROXY_FAILED", message: "Clarity could not complete the upload." },
          { status: 502 },
        );
      }
      return Response.json({ ok: false, error: "unexpected_finalize" }, { status: 500 });
    };
    try {
      await assert.rejects(
        () => saveSavedVideoToCloud(item.savedVideoId, store),
        (error) =>
          error instanceof SavedVideoCloudError &&
          error.code === "DRIVE_UPLOAD_PROXY_FAILED" &&
          error.message === "Clarity could not complete the upload."
      );
      assert.equal(fetchUrls.some((url) => url.includes("/finalize")), false);
      assert.equal((await store.getItem(item.savedVideoId))?.cloud?.status, "failed");
      assert.equal((await store.getBlob(item.savedVideoId))?.size, sourceBlob().size);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps oversized chunk upload failures to DRIVE_UPLOAD_TOO_LARGE", async () => {
    installBrowserGlobals();
    const { store, item } = await savedVideoWithLargeImages();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).includes(`/api/video-transfer/${encodeURIComponent(item.savedVideoId)}/session`)) {
        return Response.json({
          ok: true,
          status: "uploading",
          session: {
            transferId: "transfer-1",
            savedVideoId: item.savedVideoId,
            status: "uploading",
            expectedSizeBytes: sourceBlob().size,
            acceptedOffsetBytes: 0,
            chunkSizeBytes: 4,
            driveAssetFolderId: "drive-folder-1",
          },
        });
      }
      return Response.json(
        { ok: false, error: "DRIVE_UPLOAD_TOO_LARGE", message: "This transfer chunk was too large." },
        { status: 413 },
      );
    };
    try {
      await assert.rejects(
        () => saveSavedVideoToCloud(item.savedVideoId, store),
        (error) =>
          error instanceof SavedVideoCloudError &&
          error.code === "DRIVE_UPLOAD_TOO_LARGE" &&
          error.message.includes("too large")
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  it("keeps ready cloud state when re-saving identical bytes but resets it when the source changes", async () => {
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
        driveVideoFileId: "drive-video-1",
        uploadedAt: "2026-07-10T01:00:00.000Z",
      },
    });

    const resavedSame = await store.saveItem({
      savedVideoId: item.savedVideoId,
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: sourceBlob(),
      analysisSnapshot,
      workspaceSnapshot,
    });
    assert.equal(getSavedVideoCloudStatus(resavedSame).status, "ready");

    const resavedChanged = await store.saveItem({
      savedVideoId: item.savedVideoId,
      playerId: "player-1",
      sourceSide: "left",
      sourceVideo: video,
      sourceBlob: new Blob(["different-video-bytes"], { type: "video/mp4" }),
      analysisSnapshot,
      workspaceSnapshot,
    });
    assert.equal(getSavedVideoCloudStatus(resavedChanged).status, "not-uploaded");
    assert.equal(resavedChanged.cloud?.driveVideoFileId, undefined);
  });
});
