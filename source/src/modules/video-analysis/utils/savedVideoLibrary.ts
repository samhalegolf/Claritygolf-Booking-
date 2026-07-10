import type { VideoAnalysis } from "../models/Analysis";
import type { PlayerVideo } from "../models/Video";
import type { ComparisonSide, ComparisonWorkspaceState } from "./localPersistence";
import type { StoredVideo } from "./videoBlobStore";

const DB_NAME = "clarity-video-analysis";
const DB_VERSION = 2;
const SAVED_ITEMS_STORE = "savedVideoItems";
const SAVED_BLOBS_STORE = "savedVideoBlobs";
const TRANSIENT_VIDEOS_STORE = "videos";

export type SavedVideoLocalStatus = "available" | "missing" | "recovery-only" | "error";
export type SavedVideoCloudStatus = "not-uploaded" | "uploading" | "ready" | "imported" | "failed";
export type SavedVideoCloudProvider = "google-drive";

export type SavedVideoErrorCode =
  | "SAVED_VIDEO_BLOB_MISSING"
  | "SAVED_VIDEO_METADATA_MISSING"
  | "SAVED_VIDEO_WRITE_FAILED"
  | "SAVED_VIDEO_VERIFY_FAILED"
  | "SAVED_VIDEO_LOAD_FAILED"
  | "SAVED_VIDEO_DELETE_FAILED"
  | "TRANSIENT_VIDEO_NOT_FOUND";

export class SavedVideoLibraryError extends Error {
  constructor(
    public readonly code: SavedVideoErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SavedVideoLibraryError";
  }
}

export interface SavedVideoCloudState {
  status: SavedVideoCloudStatus;
  provider?: SavedVideoCloudProvider;
  driveAssetId?: string;
  driveFolderId?: string;
  driveVideoFileId?: string;
  driveManifestFileId?: string;
  driveAnalysisFileId?: string;
  progress?: number;
  uploadedAt?: string;
  lastUploadErrorCode?: string;
  errorMessage?: string;
}

export interface SavedVideoItem {
  version: 1;
  savedVideoId: string;
  playerId: string;
  lessonId?: string;
  analysisId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  capturedAt?: string;
  sourceSide: ComparisonSide;
  source: {
    originalFileName?: string;
    mimeType: string;
    sizeBytes: number;
    duration?: number;
    width?: number;
    height?: number;
    checksumSha256?: string;
    sourceDeviceId?: string;
  };
  local: {
    status: SavedVideoLocalStatus;
    blobRecordId?: string;
  };
  cloud?: SavedVideoCloudState;
  analysisSnapshot: VideoAnalysis;
  workspaceSnapshot: ComparisonWorkspaceState;
  thumbnailDataUrl?: string;
}

export interface SavedVideoBlobRecord {
  savedVideoId: string;
  blob: Blob;
  sizeBytes: number;
  mimeType: string;
  checksumSha256?: string;
  updatedAt: string;
}

export interface SaveSavedVideoInput {
  savedVideoId?: string;
  playerId: string;
  lessonId?: string;
  title?: string;
  sourceSide: ComparisonSide;
  sourceVideo: PlayerVideo;
  sourceBlob: Blob;
  analysisSnapshot: VideoAnalysis;
  workspaceSnapshot: ComparisonWorkspaceState;
  thumbnailDataUrl?: string;
}

export interface MigratedTransientVideoInput {
  savedVideoId?: string;
  storedVideo: StoredVideo;
  sourceSide: ComparisonSide;
  analysisSnapshot: VideoAnalysis;
  workspaceSnapshot: ComparisonWorkspaceState;
  thumbnailDataUrl?: string;
}

export interface SavedVideoLibraryStore {
  saveItem(input: SaveSavedVideoInput): Promise<SavedVideoItem>;
  migrateTransientVideo(input: MigratedTransientVideoInput): Promise<SavedVideoItem>;
  getItem(savedVideoId: string): Promise<SavedVideoItem | null>;
  getBlob(savedVideoId: string): Promise<Blob | null>;
  listItems(): Promise<SavedVideoItem[]>;
  listItemsForPlayer(playerId: string): Promise<SavedVideoItem[]>;
  putItem(item: SavedVideoItem): Promise<void>;
  deleteItem(savedVideoId: string): Promise<void>;
  verifyItem(savedVideoId: string): Promise<SavedVideoItem>;
}

export type SavedVideoCloudErrorCode =
  | "DRIVE_NOT_CONNECTED"
  | "DRIVE_SCOPE_MISSING"
  | "GOOGLE_RECONNECT_REQUIRED"
  | "DRIVE_FOLDER_PROVISION_FAILED"
  | "DRIVE_UPLOAD_SESSION_FAILED"
  | "DRIVE_UPLOAD_INTERRUPTED"
  | "DRIVE_UPLOAD_VERIFY_FAILED"
  | "DRIVE_FINALIZE_FAILED"
  | "SAVED_VIDEO_BLOB_MISSING";

export class SavedVideoCloudError extends Error {
  constructor(
    public readonly code: SavedVideoCloudErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "SavedVideoCloudError";
  }
}

const createSavedVideoId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `saved-video-${crypto.randomUUID()}`;
  }
  return `saved-video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const blobSize = (blob: Blob) => Math.max(0, Number(blob.size) || 0);

const bufferToHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const calculateBlobSha256 = async (blob: Blob): Promise<string | undefined> => {
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return undefined;
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return bufferToHex(digest);
  } catch {
    return undefined;
  }
};

const sortSavedItems = (items: SavedVideoItem[]) =>
  [...items].sort((left, right) =>
    String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt))
  );

const ensureStores = (db: IDBDatabase) => {
  if (!db.objectStoreNames.contains(TRANSIENT_VIDEOS_STORE)) {
    db.createObjectStore(TRANSIENT_VIDEOS_STORE);
  }
  if (!db.objectStoreNames.contains(SAVED_ITEMS_STORE)) {
    db.createObjectStore(SAVED_ITEMS_STORE, { keyPath: "savedVideoId" });
  }
  if (!db.objectStoreNames.contains(SAVED_BLOBS_STORE)) {
    db.createObjectStore(SAVED_BLOBS_STORE, { keyPath: "savedVideoId" });
  }
};

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => ensureStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open saved video library."));
    request.onblocked = () => reject(new Error("Saved video library is blocked by another tab."));
  });

const runStoreRequest = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => IDBRequest
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = operate(store);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error || new Error("Saved video library request failed."));
    transaction.onerror = () => reject(transaction.error || new Error("Saved video library transaction failed."));
    transaction.oncomplete = () => db.close();
  });
};

const buildItem = async (
  input: SaveSavedVideoInput,
  existing: SavedVideoItem | null
): Promise<{ item: SavedVideoItem; blobRecord: SavedVideoBlobRecord }> => {
  if (!input.sourceBlob || blobSize(input.sourceBlob) === 0) {
    throw new SavedVideoLibraryError(
      "TRANSIENT_VIDEO_NOT_FOUND",
      "The active video source could not be found for saving."
    );
  }

  const now = new Date().toISOString();
  const savedVideoId = input.savedVideoId || existing?.savedVideoId || createSavedVideoId();
  const checksumSha256 = await calculateBlobSha256(input.sourceBlob);
  const sizeBytes = blobSize(input.sourceBlob);
  const mimeType = input.sourceBlob.type || "application/octet-stream";
  const title =
    input.title?.trim() ||
    existing?.title ||
    input.sourceVideo.title ||
    input.analysisSnapshot.videoMeta?.title ||
    "Saved video";

  const item: SavedVideoItem = {
    version: 1,
    savedVideoId,
    playerId: input.playerId,
    lessonId: input.lessonId,
    analysisId: input.analysisSnapshot.id,
    title,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    capturedAt: existing?.capturedAt || input.sourceVideo.createdAt || input.analysisSnapshot.createdAt,
    sourceSide: input.sourceSide,
    source: {
      originalFileName: input.sourceVideo.title,
      mimeType,
      sizeBytes,
      duration: input.sourceVideo.duration ?? input.analysisSnapshot.videoMeta?.duration,
      width: input.sourceVideo.width ?? input.analysisSnapshot.videoMeta?.width,
      height: input.sourceVideo.height ?? input.analysisSnapshot.videoMeta?.height,
      checksumSha256,
    },
    local: {
      status: "available",
      blobRecordId: savedVideoId,
    },
    cloud: existing?.cloud || { status: "not-uploaded" },
    analysisSnapshot: input.analysisSnapshot,
    workspaceSnapshot: {
      ...input.workspaceSnapshot,
      savedVideoIds: {
        ...input.workspaceSnapshot.savedVideoIds,
        [input.sourceSide]: savedVideoId,
      },
    },
    thumbnailDataUrl: input.thumbnailDataUrl || existing?.thumbnailDataUrl,
  };

  return {
    item,
    blobRecord: {
      savedVideoId,
      blob: input.sourceBlob,
      sizeBytes,
      mimeType,
      checksumSha256,
      updatedAt: now,
    },
  };
};

const defaultCloudState: SavedVideoCloudState = { status: "not-uploaded" };

export const getSavedVideoCloudStatus = (item?: SavedVideoItem | null): SavedVideoCloudState =>
  item?.cloud || defaultCloudState;

const safeJson = async <T>(response: Response, fallbackMessage: string): Promise<T> => {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new SavedVideoCloudError("DRIVE_FINALIZE_FAILED", fallbackMessage, response.status);
  }
  return response.json() as Promise<T>;
};

const apiFailure = (data: any, fallback: SavedVideoCloudErrorCode): SavedVideoCloudError => {
  const code = (typeof data?.error === "string" ? data.error : fallback) as SavedVideoCloudErrorCode;
  return new SavedVideoCloudError(code, data?.message || "Google Drive upload failed.");
};

const dataUrlToBase64Size = (dataUrl?: string) => {
  const base64 = typeof dataUrl === "string" ? dataUrl.split(",")[1] || "" : "";
  if (!base64) return 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));
};

const patchCloudState = async (
  store: SavedVideoLibraryStore,
  item: SavedVideoItem,
  cloud: SavedVideoCloudState
) => {
  const next: SavedVideoItem = {
    ...item,
    source: {
      ...item.source,
      checksumSha256: item.source.checksumSha256 || undefined,
    },
    cloud,
  };
  await store.putItem(next);
  return next;
};

export const saveSavedVideoToCloud = async (
  savedVideoId: string,
  store: SavedVideoLibraryStore,
  options: {
    onProgress?: (progress: number) => void;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
  } = {}
): Promise<SavedVideoItem> => {
  const item = await store.getItem(savedVideoId);
  if (!item) {
    throw new SavedVideoLibraryError("SAVED_VIDEO_METADATA_MISSING", "Saved video metadata was not found.");
  }
  const blob = await store.getBlob(savedVideoId);
  if (!blob) {
    throw new SavedVideoCloudError("SAVED_VIDEO_BLOB_MISSING", "Saved video blob was not found.");
  }
  if (item.cloud?.status === "ready") return item;

  const checksumSha256 = item.source.checksumSha256 || (await calculateBlobSha256(blob));
  if (!checksumSha256) {
    throw new SavedVideoCloudError(
      "DRIVE_UPLOAD_VERIFY_FAILED",
      "Could not calculate a checksum for this saved video. Try again before sending it."
    );
  }

  let working = await patchCloudState(store, item, {
    ...item.cloud,
    status: "uploading",
    provider: "google-drive",
    progress: 0,
    lastUploadErrorCode: undefined,
    errorMessage: undefined,
  });

  try {
    const sessionResponse = await fetch("/api/video-transfer/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        savedVideo: {
          ...working,
          source: { ...working.source, checksumSha256 },
          analysisSnapshot: working.analysisSnapshot,
          workspaceSnapshot: working.workspaceSnapshot,
          thumbnailDataUrl: working.thumbnailDataUrl,
        },
        video: {
          fileName: working.source.originalFileName || `${working.savedVideoId}.mp4`,
          mimeType: blob.type || working.source.mimeType || "application/octet-stream",
          sizeBytes: blob.size,
          checksumSha256,
        },
        sourceDevice: {
          deviceId: options.deviceId || window.localStorage.getItem("clarityDeviceId") || "browser",
          deviceName: options.deviceName || window.navigator.userAgent.slice(0, 120),
          platform: options.platform || window.navigator.platform,
        },
      }),
    });
    const sessionData = await safeJson<any>(sessionResponse, "Upload session did not return JSON.");
    if (!sessionResponse.ok) throw apiFailure(sessionData, "DRIVE_UPLOAD_SESSION_FAILED");
    if (sessionData.status === "ready") {
      const ready = await patchCloudState(store, working, {
        status: "ready",
        provider: "google-drive",
        driveAssetId: sessionData.assetFolderId,
        driveFolderId: sessionData.assetFolderId,
        driveManifestFileId: sessionData.manifestFileId,
        progress: 100,
        uploadedAt: sessionData.uploadedAt || new Date().toISOString(),
      });
      options.onProgress?.(100);
      return ready;
    }
    if (!sessionData.uploadUrl) throw apiFailure(sessionData, "DRIVE_UPLOAD_SESSION_FAILED");

    working = await patchCloudState(store, working, {
      ...working.cloud,
      status: "uploading",
      provider: "google-drive",
      driveAssetId: sessionData.assetFolderId,
      driveFolderId: sessionData.assetFolderId,
      progress: 1,
    });

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", sessionData.uploadUrl);
      xhr.setRequestHeader("Content-Type", blob.type || working.source.mimeType || "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const progress = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
        options.onProgress?.(progress);
        void patchCloudState(store, working, { ...working.cloud, status: "uploading", progress }).then((next) => {
          working = next;
        });
      };
      xhr.onerror = () => reject(new SavedVideoCloudError("DRIVE_UPLOAD_INTERRUPTED", "Video upload was interrupted."));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new SavedVideoCloudError("DRIVE_UPLOAD_INTERRUPTED", "Google Drive did not accept the upload.", xhr.status));
      };
      xhr.send(blob);
    });

    const finalizeResponse = await fetch(`/api/video-transfer/${encodeURIComponent(savedVideoId)}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        savedVideo: {
          ...working,
          source: { ...working.source, checksumSha256 },
          analysisSnapshot: working.analysisSnapshot,
          workspaceSnapshot: working.workspaceSnapshot,
          thumbnailDataUrl: working.thumbnailDataUrl,
        },
        video: {
          fileName: working.source.originalFileName || `${working.savedVideoId}.mp4`,
          mimeType: blob.type || working.source.mimeType || "application/octet-stream",
          sizeBytes: blob.size,
          checksumSha256,
          driveFileId: sessionData.videoFileId,
        },
        snapshotBytes: dataUrlToBase64Size(working.thumbnailDataUrl),
      }),
    });
    const finalized = await safeJson<any>(finalizeResponse, "Finalize did not return JSON.");
    if (!finalizeResponse.ok || finalized.status !== "ready") throw apiFailure(finalized, "DRIVE_FINALIZE_FAILED");

    const ready = await patchCloudState(store, working, {
      status: "ready",
      provider: "google-drive",
      driveAssetId: finalized.assetFolderId,
      driveFolderId: finalized.assetFolderId,
      driveVideoFileId: finalized.videoFileId,
      driveManifestFileId: finalized.manifestFileId,
      driveAnalysisFileId: finalized.analysisFileId,
      uploadedAt: finalized.uploadedAt,
      progress: 100,
    });
    options.onProgress?.(100);
    return ready;
  } catch (error) {
    const cloudError =
      error instanceof SavedVideoCloudError
        ? error
        : new SavedVideoCloudError("DRIVE_FINALIZE_FAILED", error instanceof Error ? error.message : "Google Drive upload failed.");
    await patchCloudState(store, working, {
      ...working.cloud,
      status: "failed",
      provider: "google-drive",
      progress: undefined,
      lastUploadErrorCode: cloudError.code,
      errorMessage: cloudError.message,
    });
    throw cloudError;
  }
};

export const retrySavedVideoCloudUpload = saveSavedVideoToCloud;

export const cancelSavedVideoCloudUpload = async (
  savedVideoId: string,
  store: SavedVideoLibraryStore
): Promise<SavedVideoItem> => {
  const item = await store.getItem(savedVideoId);
  if (!item) throw new SavedVideoLibraryError("SAVED_VIDEO_METADATA_MISSING", "Saved video metadata was not found.");
  try {
    await fetch(`/api/video-transfer/${encodeURIComponent(savedVideoId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
  } catch {
    // Local retry state matters more than a best-effort cleanup request.
  }
  return patchCloudState(store, item, {
    ...item.cloud,
    status: "failed",
    provider: "google-drive",
    progress: undefined,
    lastUploadErrorCode: "DRIVE_UPLOAD_INTERRUPTED",
    errorMessage: "Upload cancelled. Retry when ready.",
  });
};

export const createIndexedDbSavedVideoLibrary = (): SavedVideoLibraryStore | null => {
  if (typeof indexedDB === "undefined" || indexedDB === null) return null;

  const getItem = async (savedVideoId: string) => {
    const item = await runStoreRequest<SavedVideoItem | undefined>(
      SAVED_ITEMS_STORE,
      "readonly",
      (store) => store.get(savedVideoId)
    );
    return item || null;
  };

  const getBlobRecord = async (savedVideoId: string) => {
    const record = await runStoreRequest<SavedVideoBlobRecord | undefined>(
      SAVED_BLOBS_STORE,
      "readonly",
      (store) => store.get(savedVideoId)
    );
    return record || null;
  };

  const store: SavedVideoLibraryStore = {
    async saveItem(input) {
      try {
        const existing = input.savedVideoId ? await getItem(input.savedVideoId) : null;
        const { item, blobRecord } = await buildItem(input, existing);
        await runStoreRequest(SAVED_BLOBS_STORE, "readwrite", (objectStore) =>
          objectStore.put(blobRecord)
        );
        await runStoreRequest(SAVED_ITEMS_STORE, "readwrite", (objectStore) =>
          objectStore.put(item)
        );
        return store.verifyItem(item.savedVideoId);
      } catch (error) {
        if (error instanceof SavedVideoLibraryError) throw error;
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_WRITE_FAILED",
          "Saved video could not be written.",
          error
        );
      }
    },

    async migrateTransientVideo(input) {
      return store.saveItem({
        savedVideoId: input.savedVideoId,
        playerId: input.storedVideo.video.playerId,
        lessonId: input.storedVideo.video.lessonId,
        title: input.storedVideo.video.title,
        sourceSide: input.sourceSide,
        sourceVideo: input.storedVideo.video,
        sourceBlob: input.storedVideo.blob,
        analysisSnapshot: input.analysisSnapshot,
        workspaceSnapshot: input.workspaceSnapshot,
        thumbnailDataUrl: input.thumbnailDataUrl,
      });
    },

    getItem,

    async getBlob(savedVideoId) {
      const record = await getBlobRecord(savedVideoId);
      return record?.blob || null;
    },

    async listItems() {
      const items = await runStoreRequest<SavedVideoItem[]>(
        SAVED_ITEMS_STORE,
        "readonly",
        (objectStore) => objectStore.getAll()
      );
      return sortSavedItems(items || []);
    },

    async listItemsForPlayer(playerId) {
      const items = await store.listItems();
      return items.filter((item) => item.playerId === playerId);
    },

    async putItem(item) {
      await runStoreRequest(SAVED_ITEMS_STORE, "readwrite", (objectStore) =>
        objectStore.put({ ...item, updatedAt: new Date().toISOString() })
      );
    },

    async deleteItem(savedVideoId) {
      try {
        await runStoreRequest(SAVED_BLOBS_STORE, "readwrite", (objectStore) =>
          objectStore.delete(savedVideoId)
        );
        await runStoreRequest(SAVED_ITEMS_STORE, "readwrite", (objectStore) =>
          objectStore.delete(savedVideoId)
        );
      } catch (error) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_DELETE_FAILED",
          "Saved video could not be deleted.",
          error
        );
      }
    },

    async verifyItem(savedVideoId) {
      const item = await getItem(savedVideoId);
      if (!item) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_METADATA_MISSING",
          "Saved video metadata was not found after saving."
        );
      }
      const blobRecord = await getBlobRecord(savedVideoId);
      if (!blobRecord?.blob) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_BLOB_MISSING",
          "Saved video blob was not found after saving."
        );
      }
      if (blobRecord.sizeBytes !== item.source.sizeBytes || blobSize(blobRecord.blob) !== item.source.sizeBytes) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_VERIFY_FAILED",
          "Saved video blob size did not match metadata."
        );
      }
      return item;
    },
  };

  return store;
};

export const createMemorySavedVideoLibraryStore = (): SavedVideoLibraryStore => {
  const items = new Map<string, SavedVideoItem>();
  const blobs = new Map<string, SavedVideoBlobRecord>();

  const store: SavedVideoLibraryStore = {
    async saveItem(input) {
      const existing = input.savedVideoId ? items.get(input.savedVideoId) || null : null;
      const { item, blobRecord } = await buildItem(input, existing);
      blobs.set(item.savedVideoId, blobRecord);
      items.set(item.savedVideoId, item);
      return store.verifyItem(item.savedVideoId);
    },

    async migrateTransientVideo(input) {
      return store.saveItem({
        savedVideoId: input.savedVideoId,
        playerId: input.storedVideo.video.playerId,
        lessonId: input.storedVideo.video.lessonId,
        title: input.storedVideo.video.title,
        sourceSide: input.sourceSide,
        sourceVideo: input.storedVideo.video,
        sourceBlob: input.storedVideo.blob,
        analysisSnapshot: input.analysisSnapshot,
        workspaceSnapshot: input.workspaceSnapshot,
        thumbnailDataUrl: input.thumbnailDataUrl,
      });
    },

    async getItem(savedVideoId) {
      return items.get(savedVideoId) || null;
    },

    async getBlob(savedVideoId) {
      return blobs.get(savedVideoId)?.blob || null;
    },

    async listItems() {
      return sortSavedItems(Array.from(items.values()));
    },

    async listItemsForPlayer(playerId) {
      return (await store.listItems()).filter((item) => item.playerId === playerId);
    },

    async putItem(item) {
      items.set(item.savedVideoId, { ...item, updatedAt: new Date().toISOString() });
    },

    async deleteItem(savedVideoId) {
      blobs.delete(savedVideoId);
      items.delete(savedVideoId);
    },

    async verifyItem(savedVideoId) {
      const item = items.get(savedVideoId);
      if (!item) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_METADATA_MISSING",
          "Saved video metadata is missing."
        );
      }
      const blobRecord = blobs.get(savedVideoId);
      if (!blobRecord?.blob) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_BLOB_MISSING",
          "Saved video blob is missing."
        );
      }
      if (blobRecord.sizeBytes !== item.source.sizeBytes || blobSize(blobRecord.blob) !== item.source.sizeBytes) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_VERIFY_FAILED",
          "Saved video blob size did not match metadata."
        );
      }
      return item;
    },
  };

  return store;
};
