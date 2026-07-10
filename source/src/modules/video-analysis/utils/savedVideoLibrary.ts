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
  driveVideoFileId?: string;
  driveManifestFileId?: string;
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

export const saveSavedVideoToCloud = async (): Promise<never> => {
  throw new SavedVideoLibraryError(
    "SAVED_VIDEO_WRITE_FAILED",
    "Cloud transfer is not implemented yet. Save locally first."
  );
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
