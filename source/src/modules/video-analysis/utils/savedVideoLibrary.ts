import type { VideoAnalysis } from "../models/Analysis";
import type { PlayerVideo } from "../models/Video";
import type { ComparisonSide, ComparisonWorkspaceState } from "./localPersistence";
import type { StoredVideo } from "./videoBlobStore";

const DB_NAME = "clarity-video-analysis";
const DB_VERSION = 3;
const SAVED_ITEMS_STORE = "savedVideoItems";
const SAVED_BLOBS_STORE = "savedVideoBlobs";
const TRANSIENT_VIDEOS_STORE = "videos";
const MANAGED_LIBRARY_STORE = "managedLocalLibrary";
const MANAGED_LIBRARY_HANDLE_KEY = "rootDirectory";
const MANAGED_LIBRARY_MANIFEST = "manifest.json";
const MANAGED_LIBRARY_VIDEO_FILE = "video.mp4";

type FileSystemPermissionMode = "read" | "readwrite";
type FileSystemPermissionState = "granted" | "denied" | "prompt";

interface FileSystemPermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle {
  kind: "directory";
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<FileSystemPermissionState>;
  requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<FileSystemPermissionState>;
}

interface WindowWithFileSystemAccess extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
  }) => Promise<FileSystemDirectoryHandle>;
}

export type SavedVideoLocalStatus = "available" | "missing" | "recovery-only" | "error";
export type ManagedLocalLibraryHealth =
  | "healthy"
  | "missing"
  | "moved"
  | "read-only"
  | "permission-lost"
  | "repair-required"
  | "not-configured"
  | "unsupported";
export type SavedVideoCloudStatus = "not-uploaded" | "preparing" | "uploading" | "paused" | "verifying" | "ready" | "imported" | "failed" | "cancelled" | "expired";
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
  transferId?: string;
  driveAssetId?: string;
  driveFolderId?: string;
  driveVideoFileId?: string;
  driveManifestFileId?: string;
  driveAnalysisFileId?: string;
  acceptedOffsetBytes?: number;
  expectedSizeBytes?: number;
  chunkSizeBytes?: number;
  progress?: number;
  uploadedAt?: string;
  lastUploadErrorCode?: string;
  errorMessage?: string;
}

export interface SavedVideoManagedLocalState {
  status: ManagedLocalLibraryHealth;
  libraryId?: string;
  migratedAt?: string;
  verifiedAt?: string;
  lastError?: string;
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
    managed?: SavedVideoManagedLocalState;
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

export type CreateVideoUploadSessionRequest = {
  savedVideoId: string;
  playerId: string;
  lessonId?: string;
  analysisId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  video: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256: string;
  };
  sourceDevice?: {
    deviceId: string;
    deviceName?: string;
    platform?: string;
  };
};

export type FinalizeVideoUploadRequest = CreateVideoUploadSessionRequest & {
  video: CreateVideoUploadSessionRequest["video"] & {
    driveFileId: string;
  };
  analysisJson: CompactSavedVideoAnalysisJson;
};

export type CompactSavedVideoAnalysisJson = {
  savedVideoId: string;
  analysis: Omit<VideoAnalysis, "markers" | "focusSnapshots" | "focusViews" | "narrationRefs"> & {
    markers: Array<Omit<VideoAnalysis["markers"][number], "thumbnail">>;
    focusSnapshots: Array<Omit<VideoAnalysis["focusSnapshots"][number], "imageDataUrl">>;
    focusViews: unknown[];
    narrationRefs: unknown[];
  };
  workspace: ComparisonWorkspaceState;
};

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
  | "DRIVE_UPLOAD_PROXY_FAILED"
  | "DRIVE_UPLOAD_TOO_LARGE"
  | "DRIVE_UPLOAD_SESSION_EXPIRED"
  | "DRIVE_UPLOAD_INTERRUPTED"
  | "DRIVE_UPLOAD_VERIFY_FAILED"
  | "DRIVE_FINALIZE_FAILED"
  | "SAVED_VIDEO_BLOB_MISSING"
  | "SAVED_VIDEO_SOURCE_MISSING"
  | "TRANSFER_PAUSED"
  | "TRANSFER_CANCELLED";

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

const nowIso = () => new Date().toISOString();

const createStableId = (prefix: string) => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const sanitizeSegment = (value: string, fallback: string) => {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || fallback;
};

const isFileSystemAccessSupported = () =>
  typeof window !== "undefined" &&
  typeof (window as WindowWithFileSystemAccess).showDirectoryPicker === "function";

const jsonBlob = (value: unknown) =>
  new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });

const dataUrlToBlob = (dataUrl?: string): Blob | null => {
  if (!dataUrl) return null;
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  try {
    const mimeType = match[1] || "application/octet-stream";
    const payload = match[3] || "";
    const binary = match[2] ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
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
  if (!db.objectStoreNames.contains(MANAGED_LIBRARY_STORE)) {
    db.createObjectStore(MANAGED_LIBRARY_STORE);
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
  // If the saved bytes changed, any previous cloud upload is stale and the
  // item must be sendable again. Compare by checksum when available,
  // falling back to size.
  const sourceUnchanged = Boolean(
    existing &&
      (existing.source.checksumSha256 && checksumSha256
        ? existing.source.checksumSha256 === checksumSha256
        : existing.source.sizeBytes === sizeBytes)
  );
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
    cloud: sourceUnchanged ? existing?.cloud || { status: "not-uploaded" } : { status: "not-uploaded" },
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

const safeJson = async <T>(
  response: Response,
  fallbackMessage: string,
  errorCode: SavedVideoCloudErrorCode
): Promise<T> => {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const responseText = await response.text().catch(() => "");
    const safePreview = firstSafeResponseText(responseText);
    const typeLabel = contentType.split(";")[0].trim() || "unknown content type";
    const detail = safePreview ? `: ${safePreview}` : "";
    throw new SavedVideoCloudError(
      errorCode,
      `${fallbackMessage} (HTTP ${response.status}, ${typeLabel})${detail}`,
      response.status
    );
  }
  return response.json() as Promise<T>;
};

const apiFailure = (data: any, fallback: SavedVideoCloudErrorCode): SavedVideoCloudError => {
  const code = (typeof data?.error === "string" ? data.error : fallback) as SavedVideoCloudErrorCode;
  return new SavedVideoCloudError(code, data?.message || "Google Drive upload failed.", data?.status);
};

type PublicTransferSession = {
  transferId: string;
  savedVideoId: string;
  status: SavedVideoCloudStatus;
  expectedSizeBytes: number;
  acceptedOffsetBytes: number;
  chunkSizeBytes: number;
  driveAssetFolderId?: string;
  driveVideoFileId?: string;
  driveManifestFileId?: string;
  driveAnalysisFileId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
};

const transferProgress = (acceptedOffsetBytes = 0, expectedSizeBytes = 0) =>
  expectedSizeBytes > 0 ? Math.max(1, Math.min(99, Math.floor((acceptedOffsetBytes / expectedSizeBytes) * 100))) : 1;

const sessionFromResponse = (data: any): PublicTransferSession => data?.session || data;

const applyTransferSessionToCloud = (
  cloud: SavedVideoCloudState | undefined,
  session: PublicTransferSession
): SavedVideoCloudState => ({
  ...cloud,
  status: session.status,
  provider: "google-drive",
  transferId: session.transferId,
  driveAssetId: session.driveAssetFolderId || cloud?.driveAssetId,
  driveFolderId: session.driveAssetFolderId || cloud?.driveFolderId,
  driveVideoFileId: session.driveVideoFileId || cloud?.driveVideoFileId,
  driveManifestFileId: session.driveManifestFileId || cloud?.driveManifestFileId,
  driveAnalysisFileId: session.driveAnalysisFileId || cloud?.driveAnalysisFileId,
  acceptedOffsetBytes: session.acceptedOffsetBytes,
  expectedSizeBytes: session.expectedSizeBytes,
  chunkSizeBytes: session.chunkSizeBytes,
  progress: session.status === "ready" ? 100 : transferProgress(session.acceptedOffsetBytes, session.expectedSizeBytes),
  lastUploadErrorCode: session.lastErrorCode,
  errorMessage: session.lastErrorMessage,
});

const uploadChunkToClarity = async (
  savedVideoId: string,
  session: PublicTransferSession,
  chunk: Blob,
  startByte: number,
  totalSize: number,
  mimeType: string
): Promise<PublicTransferSession> => {
  const endByte = startByte + chunk.size - 1;
  const response = await fetch(`/api/video-transfer/${encodeURIComponent(savedVideoId)}/chunk`, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      Accept: "application/json",
      "X-Clarity-Transfer-Id": session.transferId,
      "X-Clarity-Start-Byte": String(startByte),
      "X-Clarity-End-Byte": String(endByte),
      "X-Clarity-Total-Size": String(totalSize),
    },
    body: chunk,
  });
  const data = await safeJson<any>(response, "Chunk upload did not return JSON.", "DRIVE_UPLOAD_PROXY_FAILED");
  if (!response.ok || data.ok === false) throw apiFailure(data, response.status === 413 ? "DRIVE_UPLOAD_TOO_LARGE" : "DRIVE_UPLOAD_PROXY_FAILED");
  return sessionFromResponse(data);
};

// The server answers Google 429/5xx with DRIVE_UPLOAD_INTERRUPTED and keeps
// the accepted offset unchanged, so the same chunk can be retried safely.
const uploadChunkWithRetry = async (
  savedVideoId: string,
  session: PublicTransferSession,
  chunk: Blob,
  startByte: number,
  totalSize: number,
  mimeType: string
): Promise<PublicTransferSession> => {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await uploadChunkToClarity(savedVideoId, session, chunk, startByte, totalSize, mimeType);
    } catch (error) {
      const retryable = error instanceof SavedVideoCloudError && error.code === "DRIVE_UPLOAD_INTERRUPTED";
      if (!retryable || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
};

const dataUrlToBase64Size = (dataUrl?: string) => {
  const base64 = typeof dataUrl === "string" ? dataUrl.split(",")[1] || "" : "";
  if (!base64) return 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));
};

const firstSafeResponseText = (text: string) =>
  text
    .replace(/(cookie|authorization|token|secret|api[_-]?key)\s*[:=]\s*["']?[^"'\s<]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

const stripDataUrls = (value: unknown): unknown => {
  if (typeof value === "string") return value.startsWith("data:") ? undefined : value;
  if (Array.isArray(value)) return value.map(stripDataUrls).filter((entry) => entry !== undefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, stripDataUrls(entry)] as const)
      .filter(([, entry]) => entry !== undefined)
  );
};

export const buildVideoUploadSessionRequest = (
  item: SavedVideoItem,
  blob: Blob,
  checksumSha256: string,
  sourceDevice?: CreateVideoUploadSessionRequest["sourceDevice"]
): CreateVideoUploadSessionRequest => ({
  savedVideoId: item.savedVideoId,
  playerId: item.playerId,
  lessonId: item.lessonId,
  analysisId: item.analysisId,
  title: item.title,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  video: {
    fileName: item.source.originalFileName || `${item.savedVideoId}.mp4`,
    mimeType: blob.type || item.source.mimeType || "application/octet-stream",
    sizeBytes: blob.size,
    checksumSha256,
  },
  sourceDevice,
});

export const compactSavedVideoAnalysisJson = (item: SavedVideoItem): CompactSavedVideoAnalysisJson => ({
  savedVideoId: item.savedVideoId,
  analysis: {
    ...item.analysisSnapshot,
    markers: item.analysisSnapshot.markers.map(({ thumbnail: _thumbnail, ...marker }) => marker),
    focusSnapshots: item.analysisSnapshot.focusSnapshots.map(({ imageDataUrl: _imageDataUrl, ...snapshot }) => snapshot),
    focusViews: stripDataUrls(item.analysisSnapshot.focusViews) as unknown[],
    narrationRefs: stripDataUrls(item.analysisSnapshot.narrationRefs) as unknown[],
  },
  workspace: stripDataUrls(item.workspaceSnapshot) as ComparisonWorkspaceState,
});

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
    throw new SavedVideoCloudError("SAVED_VIDEO_SOURCE_MISSING", "Saved video source was not found.");
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
    status: "preparing",
    provider: "google-drive",
    progress: 0,
    lastUploadErrorCode: undefined,
    errorMessage: undefined,
  });

  try {
    const sourceDevice = {
      deviceId: options.deviceId || window.localStorage.getItem("clarityDeviceId") || "browser",
      deviceName: options.deviceName || window.navigator.userAgent.slice(0, 120),
      platform: options.platform || window.navigator.platform,
    };
    const uploadSessionRequest = buildVideoUploadSessionRequest(working, blob, checksumSha256, sourceDevice);
    const sessionResponse = await fetch(`/api/video-transfer/${encodeURIComponent(savedVideoId)}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(uploadSessionRequest),
    });
    const sessionData = await safeJson<any>(
      sessionResponse,
      "Upload session failed before reaching Clarity server",
      "DRIVE_UPLOAD_SESSION_FAILED"
    );
    if (!sessionResponse.ok) throw apiFailure(sessionData, "DRIVE_UPLOAD_SESSION_FAILED");
    let session = sessionFromResponse(sessionData);
    if (session.status === "ready") {
      const ready = await patchCloudState(store, working, {
        status: "ready",
        provider: "google-drive",
        transferId: session.transferId,
        driveAssetId: session.driveAssetFolderId,
        driveFolderId: session.driveAssetFolderId,
        driveManifestFileId: session.driveManifestFileId,
        progress: 100,
        uploadedAt: new Date().toISOString(),
      });
      options.onProgress?.(100);
      return ready;
    }
    working = await patchCloudState(store, working, applyTransferSessionToCloud(working.cloud, session));
    options.onProgress?.(working.cloud?.progress || 1);

    while (session.acceptedOffsetBytes < session.expectedSizeBytes) {
      const startByte = session.acceptedOffsetBytes;
      const endByteExclusive = Math.min(session.expectedSizeBytes, startByte + session.chunkSizeBytes);
      const chunk = blob.slice(startByte, endByteExclusive, blob.type || working.source.mimeType || "application/octet-stream");
      session = await uploadChunkWithRetry(
        savedVideoId,
        session,
        chunk,
        startByte,
        session.expectedSizeBytes,
        blob.type || working.source.mimeType || "application/octet-stream"
      );
      working = await patchCloudState(store, working, applyTransferSessionToCloud(working.cloud, session));
      options.onProgress?.(working.cloud?.progress || transferProgress(session.acceptedOffsetBytes, session.expectedSizeBytes));
    }

    if (!session.driveVideoFileId && working.cloud?.driveVideoFileId) {
      session = { ...session, driveVideoFileId: working.cloud.driveVideoFileId };
    }
    if (!session.driveVideoFileId) throw new SavedVideoCloudError("DRIVE_UPLOAD_VERIFY_FAILED", "Clarity could not verify the uploaded video.");

    working = await patchCloudState(store, working, {
      ...working.cloud,
      status: "verifying",
      provider: "google-drive",
      driveVideoFileId: session.driveVideoFileId,
      progress: 99,
    });

    const finalizeResponse = await fetch(`/api/video-transfer/${encodeURIComponent(savedVideoId)}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        savedVideoId: working.savedVideoId,
        playerId: working.playerId,
        lessonId: working.lessonId,
        analysisId: working.analysisId,
        title: working.title,
        createdAt: working.createdAt,
        updatedAt: working.updatedAt,
        video: {
          fileName: working.source.originalFileName || `${working.savedVideoId}.mp4`,
          mimeType: blob.type || working.source.mimeType || "application/octet-stream",
          sizeBytes: blob.size,
          checksumSha256,
          driveFileId: session.driveVideoFileId,
        },
        analysisJson: compactSavedVideoAnalysisJson(working),
        snapshotBytes: dataUrlToBase64Size(working.thumbnailDataUrl),
      }),
    });
    const finalized = await safeJson<any>(finalizeResponse, "Finalize did not return JSON.", "DRIVE_FINALIZE_FAILED");
    if (!finalizeResponse.ok || finalized.status !== "ready") throw apiFailure(finalized, "DRIVE_FINALIZE_FAILED");

    const ready = await patchCloudState(store, working, {
      status: "ready",
      provider: "google-drive",
      driveAssetId: finalized.assetFolderId,
      driveFolderId: finalized.assetFolderId,
      driveVideoFileId: finalized.videoFileId,
      transferId: finalized.session?.transferId || working.cloud?.transferId,
      driveManifestFileId: finalized.manifestFileId,
      driveAnalysisFileId: finalized.analysisFileId,
      acceptedOffsetBytes: blob.size,
      expectedSizeBytes: blob.size,
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

export const pauseSavedVideoCloudUpload = async (
  savedVideoId: string,
  store: SavedVideoLibraryStore
): Promise<SavedVideoItem> => {
  const item = await store.getItem(savedVideoId);
  if (!item) throw new SavedVideoLibraryError("SAVED_VIDEO_METADATA_MISSING", "Saved video metadata was not found.");
  try {
    const response = await fetch(`/api/video-transfer/${encodeURIComponent(savedVideoId)}/pause`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const data = await safeJson<any>(response, "Pause did not return JSON.", "DRIVE_UPLOAD_INTERRUPTED");
    if (!response.ok || data.ok === false) throw apiFailure(data, "DRIVE_UPLOAD_INTERRUPTED");
    return patchCloudState(store, item, applyTransferSessionToCloud(item.cloud, sessionFromResponse(data)));
  } catch (error) {
    if (error instanceof SavedVideoCloudError) throw error;
    throw new SavedVideoCloudError("DRIVE_UPLOAD_INTERRUPTED", error instanceof Error ? error.message : "Could not pause transfer.");
  }
};

export const cancelSavedVideoCloudUpload = async (
  savedVideoId: string,
  store: SavedVideoLibraryStore
): Promise<SavedVideoItem> => {
  const item = await store.getItem(savedVideoId);
  if (!item) throw new SavedVideoLibraryError("SAVED_VIDEO_METADATA_MISSING", "Saved video metadata was not found.");
  try {
    await fetch(`/api/video-transfer/${encodeURIComponent(savedVideoId)}/session`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
  } catch {
    // Local retry state matters more than a best-effort cleanup request.
  }
  return patchCloudState(store, item, {
    ...item.cloud,
    status: "cancelled",
    provider: "google-drive",
    progress: undefined,
    lastUploadErrorCode: "DRIVE_UPLOAD_INTERRUPTED",
    errorMessage: "Upload cancelled. Retry when ready.",
  });
};

export interface ManagedLocalVideoLibraryStatus {
  supported: boolean;
  configured: boolean;
  health: ManagedLocalLibraryHealth;
  message: string;
}

const runManagedHandleRequest = async <T>(
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => IDBRequest
): Promise<T> => runStoreRequest<T>(MANAGED_LIBRARY_STORE, mode, operate);

const getStoredManagedRootHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  try {
    const handle = await runManagedHandleRequest<FileSystemDirectoryHandle | undefined>(
      "readonly",
      (store) => store.get(MANAGED_LIBRARY_HANDLE_KEY)
    );
    return handle || null;
  } catch {
    return null;
  }
};

const storeManagedRootHandle = (handle: FileSystemDirectoryHandle) =>
  runManagedHandleRequest<void>("readwrite", (store) => store.put(handle, MANAGED_LIBRARY_HANDLE_KEY));

const getManagedPermission = async (
  handle: FileSystemDirectoryHandle | null,
  request = false
): Promise<FileSystemPermissionState> => {
  if (!handle) return "denied";
  try {
    const descriptor = { mode: "readwrite" as const };
    if (request && typeof handle.requestPermission === "function") {
      return await handle.requestPermission(descriptor);
    }
    if (typeof handle.queryPermission === "function") {
      return await handle.queryPermission(descriptor);
    }
    return "granted";
  } catch {
    return "denied";
  }
};

const writeFile = async (directory: FileSystemDirectoryHandle, fileName: string, value: Blob | string) => {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(value);
  await writable.close();
};

const readJsonFile = async <T>(directory: FileSystemDirectoryHandle, fileName: string): Promise<T | null> => {
  try {
    const fileHandle = await directory.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
};

const ensureManagedSystemFolders = async (root: FileSystemDirectoryHandle) => {
  const system = await root.getDirectoryHandle("System", { create: true });
  await Promise.all([
    system.getDirectoryHandle("imports", { create: true }),
    system.getDirectoryHandle("logs", { create: true }),
    system.getDirectoryHandle("cache", { create: true }),
  ]);
};

const ensureManagedRootManifest = async (root: FileSystemDirectoryHandle) => {
  const existing = await readJsonFile<{ version?: number; libraryId?: string; app?: string; createdAt?: string }>(
    root,
    MANAGED_LIBRARY_MANIFEST
  );
  const now = nowIso();
  const manifest = {
    version: 1,
    app: "clarity-booking",
    libraryId:
      existing?.version === 1 && existing.app === "clarity-booking" && existing.libraryId
        ? existing.libraryId
        : createStableId("clarity-video-library"),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await writeFile(root, MANAGED_LIBRARY_MANIFEST, jsonBlob(manifest));
  return manifest;
};

const getManagedSavedVideoDirectory = async (
  root: FileSystemDirectoryHandle,
  playerId: string,
  savedVideoId: string,
  create: boolean
) => {
  const players = await root.getDirectoryHandle("Players", { create });
  const player = await players.getDirectoryHandle(sanitizeSegment(playerId, "player"), { create });
  const videos = await player.getDirectoryHandle("Videos", { create });
  return videos.getDirectoryHandle(sanitizeSegment(savedVideoId, "saved-video"), { create });
};

const managedHealthFromError = (error: unknown): ManagedLocalLibraryHealth => {
  const name = typeof error === "object" && error && "name" in error ? String((error as { name?: unknown }).name) : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (name === "NotFoundError") return "missing";
  if (name === "NotAllowedError" || message.includes("permission")) return "permission-lost";
  if (message.includes("read-only") || message.includes("read only")) return "read-only";
  return "repair-required";
};

const managedStatusMessage = (health: ManagedLocalLibraryHealth) => {
  switch (health) {
    case "healthy":
      return "Healthy";
    case "missing":
      return "Missing file";
    case "moved":
      return "Moved";
    case "read-only":
      return "Read only";
    case "permission-lost":
      return "Permission lost";
    case "repair-required":
      return "Repair required";
    case "unsupported":
      return "File System Access is unavailable. Working from local cache.";
    case "not-configured":
    default:
      return "Choose Clarity Video Library";
  }
};

export const getManagedLocalVideoLibraryStatus = async (): Promise<ManagedLocalVideoLibraryStatus> => {
  if (!isFileSystemAccessSupported()) {
    return {
      supported: false,
      configured: false,
      health: "unsupported",
      message: managedStatusMessage("unsupported"),
    };
  }
  const root = await getStoredManagedRootHandle();
  if (!root) {
    return {
      supported: true,
      configured: false,
      health: "not-configured",
      message: managedStatusMessage("not-configured"),
    };
  }
  const permission = await getManagedPermission(root);
  if (permission !== "granted") {
    return {
      supported: true,
      configured: true,
      health: "permission-lost",
      message: managedStatusMessage("permission-lost"),
    };
  }
  try {
    await ensureManagedSystemFolders(root);
    await ensureManagedRootManifest(root);
    const cache = await root
      .getDirectoryHandle("System", { create: true })
      .then((system) => system.getDirectoryHandle("cache", { create: true }));
    await writeFile(cache, ".clarity-write-test", "ok");
    await cache.removeEntry?.(".clarity-write-test");
    return {
      supported: true,
      configured: true,
      health: "healthy",
      message: managedStatusMessage("healthy"),
    };
  } catch (error) {
    const health = managedHealthFromError(error);
    return {
      supported: true,
      configured: true,
      health,
      message: managedStatusMessage(health),
    };
  }
};

export const chooseManagedLocalVideoLibrary = async (): Promise<ManagedLocalVideoLibraryStatus> => {
  const picker = (window as WindowWithFileSystemAccess).showDirectoryPicker;
  if (!picker) return getManagedLocalVideoLibraryStatus();
  const root = await picker({
    id: "clarity-video-library",
    mode: "readwrite",
    startIn: "documents",
  });
  await storeManagedRootHandle(root);
  await getManagedPermission(root, true);
  await ensureManagedSystemFolders(root);
  await ensureManagedRootManifest(root);
  return getManagedLocalVideoLibraryStatus();
};

export const reconnectManagedLocalVideoLibrary = async () => {
  const root = await getStoredManagedRootHandle();
  if (!root) return chooseManagedLocalVideoLibrary();
  await getManagedPermission(root, true);
  return getManagedLocalVideoLibraryStatus();
};

export const moveManagedLocalVideoLibrary = async (store: SavedVideoLibraryStore) => {
  const status = await chooseManagedLocalVideoLibrary();
  if (status.health === "healthy") {
    await migrateSavedVideosToManagedLocalLibrary(store);
  }
  return getManagedLocalVideoLibraryStatus();
};

const markManagedFailure = (item: SavedVideoItem, error: unknown): SavedVideoItem => {
  const status = managedHealthFromError(error);
  return {
    ...item,
    local: {
      ...item.local,
      status: item.local.status === "available" ? "recovery-only" : item.local.status,
      managed: {
        ...item.local.managed,
        status,
        lastError: error instanceof Error ? error.message : managedStatusMessage(status),
      },
    },
  };
};

const writeManagedSavedVideo = async (
  item: SavedVideoItem,
  blobRecord: SavedVideoBlobRecord
): Promise<SavedVideoItem> => {
  const root = await getStoredManagedRootHandle();
  if (!root) return item;
  const permission = await getManagedPermission(root, true);
  if (permission !== "granted") throw new Error("Permission lost");
  const libraryManifest = await ensureManagedRootManifest(root);
  await ensureManagedSystemFolders(root);
  const directory = await getManagedSavedVideoDirectory(root, item.playerId, item.savedVideoId, true);
  const snapshots = await directory.getDirectoryHandle("snapshots", { create: true });
  await writeFile(directory, MANAGED_LIBRARY_VIDEO_FILE, blobRecord.blob);
  await writeFile(directory, "analysis.json", jsonBlob(compactSavedVideoAnalysisJson(item)));
  await writeFile(
    directory,
    "metadata.json",
    jsonBlob({
      version: 1,
      savedVideoId: item.savedVideoId,
      playerId: item.playerId,
      lessonId: item.lessonId,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      capturedAt: item.capturedAt,
      source: item.source,
      local: { status: "managed-library" },
      cloud: item.cloud,
    })
  );
  await writeFile(
    directory,
    MANAGED_LIBRARY_MANIFEST,
    jsonBlob({
      version: 1,
      app: "clarity-booking",
      libraryId: libraryManifest.libraryId,
      savedVideoId: item.savedVideoId,
      playerId: item.playerId,
      videoFile: MANAGED_LIBRARY_VIDEO_FILE,
      analysisFile: "analysis.json",
      metadataFile: "metadata.json",
      snapshotsDirectory: "snapshots",
      checksumSha256: blobRecord.checksumSha256,
      sizeBytes: blobRecord.sizeBytes,
      updatedAt: nowIso(),
    })
  );
  const thumb = dataUrlToBlob(item.thumbnailDataUrl);
  if (thumb) await writeFile(snapshots, "thumbnail.jpg", thumb);
  const verified = await directory.getFileHandle(MANAGED_LIBRARY_VIDEO_FILE).then((handle) => handle.getFile());
  if (verified.size !== blobRecord.sizeBytes) {
    throw new SavedVideoLibraryError("SAVED_VIDEO_VERIFY_FAILED", "Managed library video did not match metadata.");
  }
  return {
    ...item,
    local: {
      ...item.local,
      status: "available",
      managed: {
        status: "healthy",
        libraryId: libraryManifest.libraryId,
        migratedAt: item.local.managed?.migratedAt || nowIso(),
        verifiedAt: nowIso(),
      },
    },
  };
};

const readManagedSavedVideoBlob = async (item: SavedVideoItem): Promise<Blob | null> => {
  if (!item.local.managed || item.local.managed.status === "not-configured") return null;
  const root = await getStoredManagedRootHandle();
  if (!root || (await getManagedPermission(root)) !== "granted") return null;
  const directory = await getManagedSavedVideoDirectory(root, item.playerId, item.savedVideoId, false);
  const file = await directory.getFileHandle(MANAGED_LIBRARY_VIDEO_FILE).then((handle) => handle.getFile());
  return file.size > 0 ? file : null;
};

const verifyManagedSavedVideo = async (item: SavedVideoItem): Promise<SavedVideoItem> => {
  try {
    const blob = await readManagedSavedVideoBlob(item);
    if (!blob) throw new SavedVideoLibraryError("SAVED_VIDEO_BLOB_MISSING", "Managed library file is missing.");
    if (blobSize(blob) !== item.source.sizeBytes) {
      throw new SavedVideoLibraryError("SAVED_VIDEO_VERIFY_FAILED", "Managed library file size does not match metadata.");
    }
    return {
      ...item,
      local: {
        ...item.local,
        status: "available",
        managed: {
          ...item.local.managed,
          status: "healthy",
          verifiedAt: nowIso(),
        },
      },
    };
  } catch (error) {
    return markManagedFailure(item, error);
  }
};

export const migrateSavedVideosToManagedLocalLibrary = async (
  store: SavedVideoLibraryStore
): Promise<{ migrated: number; failed: number }> => {
  const status = await getManagedLocalVideoLibraryStatus();
  if (status.health !== "healthy") return { migrated: 0, failed: 0 };
  const items = await store.listItems();
  let migrated = 0;
  let failed = 0;
  for (const item of items) {
    const blob = await store.getBlob(item.savedVideoId);
    if (!blob) {
      failed += 1;
      continue;
    }
    const blobRecord: SavedVideoBlobRecord = {
      savedVideoId: item.savedVideoId,
      blob,
      sizeBytes: blobSize(blob),
      mimeType: blob.type || item.source.mimeType || "video/mp4",
      checksumSha256: item.source.checksumSha256 || (await calculateBlobSha256(blob)),
      updatedAt: nowIso(),
    };
    try {
      await store.putItem(await writeManagedSavedVideo(item, blobRecord));
      migrated += 1;
    } catch (error) {
      await store.putItem(markManagedFailure(item, error));
      failed += 1;
    }
  }
  return { migrated, failed };
};

export const verifyManagedLocalVideoLibrary = async (store: SavedVideoLibraryStore) => {
  const status = await getManagedLocalVideoLibraryStatus();
  if (status.health !== "healthy") return { status, verified: 0, repaired: 0 };
  const items = await store.listItems();
  let verified = 0;
  let repaired = 0;
  for (const item of items) {
    const next = await verifyManagedSavedVideo(item);
    if (next.local.managed?.status === "healthy") verified += 1;
    else repaired += 1;
    await store.putItem(next);
  }
  return { status: await getManagedLocalVideoLibraryStatus(), verified, repaired };
};

export const rescanManagedLocalVideoLibrary = verifyManagedLocalVideoLibrary;

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
        let durableItem = item;
        try {
          durableItem = await writeManagedSavedVideo(item, blobRecord);
        } catch (error) {
          durableItem = markManagedFailure(item, error);
        }
        await runStoreRequest(SAVED_BLOBS_STORE, "readwrite", (objectStore) =>
          objectStore.put(blobRecord)
        );
        await runStoreRequest(SAVED_ITEMS_STORE, "readwrite", (objectStore) =>
          objectStore.put(durableItem)
        );
        return store.verifyItem(durableItem.savedVideoId);
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
      const item = await getItem(savedVideoId);
      if (item?.local.managed?.status === "healthy") {
        try {
          const managedBlob = await readManagedSavedVideoBlob(item);
          if (managedBlob) return managedBlob;
          await store.putItem(markManagedFailure(item, new Error("Managed library file is missing.")));
        } catch (error) {
          await store.putItem(markManagedFailure(item, error));
        }
      }
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
        const item = await getItem(savedVideoId);
        const root = await getStoredManagedRootHandle();
        if (item && root && (await getManagedPermission(root)) === "granted") {
          await getManagedSavedVideoDirectory(root, item.playerId, item.savedVideoId, false)
            .then(async (_directory) => {
              const videos = await root
                .getDirectoryHandle("Players")
                .then((players) => players.getDirectoryHandle(sanitizeSegment(item.playerId, "player")))
                .then((player) => player.getDirectoryHandle("Videos"));
              await videos.removeEntry?.(sanitizeSegment(item.savedVideoId, "saved-video"), { recursive: true });
            })
            .catch(() => {
              // IndexedDB metadata/cache cleanup must still proceed.
            });
        }
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
      let currentItem = item;
      if (item.local.managed) {
        currentItem = await verifyManagedSavedVideo(item);
        if (currentItem !== item) {
          await runStoreRequest(SAVED_ITEMS_STORE, "readwrite", (objectStore) =>
            objectStore.put(currentItem)
          );
        }
      }
      const blobRecord = await getBlobRecord(savedVideoId);
      if (!blobRecord?.blob && currentItem.local.managed?.status !== "healthy") {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_BLOB_MISSING",
          "Saved video blob was not found after saving."
        );
      }
      if (
        blobRecord?.blob &&
        (blobRecord.sizeBytes !== currentItem.source.sizeBytes || blobSize(blobRecord.blob) !== currentItem.source.sizeBytes)
      ) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_VERIFY_FAILED",
          "Saved video blob size did not match metadata."
        );
      }
      return currentItem;
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
