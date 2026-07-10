import type { FocusSnapshot, VideoAnalysis } from "../models/Analysis";
import type { PlayerVideo } from "../models/Video";
import type {
  ComparisonSide,
  VideoAnalysisSaveArtifact,
} from "./localPersistence";
import {
  buildVideoSlotKey,
  createIndexedDbVideoStore,
  type StoredVideo,
  type VideoBlobStore,
} from "./videoBlobStore";

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
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<FileSystemPermissionState>;
  requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<FileSystemPermissionState>;
}

interface WindowWithFileSystemAccess extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

export type LocalLibraryAvailability =
  | "available"
  | "needs-reconnect"
  | "missing"
  | "fallback";

export interface LocalVideoLibraryManifest {
  version: 1;
  libraryId: string;
  createdAt: string;
  updatedAt: string;
  app: "clarity-booking";
}

export interface LocalVideoLibraryIndexEntry {
  version: 1;
  analysisId: string;
  playerId: string;
  playerName: string;
  lessonId?: string;
  lessonTitle?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  thumbnailDataUrl?: string;
  videos: Partial<Record<ComparisonSide, PlayerVideo & { fileName?: string }>>;
  availability: LocalLibraryAvailability;
}

export interface LocalVideoLibraryStatus {
  supported: boolean;
  configured: boolean;
  permission: FileSystemPermissionState | "unsupported" | "unknown";
  mode: "managed-folder" | "browser-bound";
  message: string;
}

export interface SaveManagedLocalProjectArgs {
  artifact: VideoAnalysisSaveArtifact;
  playerName: string;
  lessonTitle?: string;
  videos: Partial<Record<ComparisonSide, PlayerVideo | null>>;
}

const LIBRARY_DB_NAME = "clarity-video-analysis-local-library";
const LIBRARY_DB_VERSION = 1;
const HANDLE_STORE_NAME = "handles";
const INDEX_STORE_NAME = "index";
const ROOT_HANDLE_KEY = "root-directory";
const LIBRARY_MANIFEST_FILE = "library.json";
const INDEX_KEY_PREFIX = "analysis.";
const ROOT_MANIFEST_ID_PREFIX = "clarity-video-library";

const fallbackVideoStore = createIndexedDbVideoStore();

const nowIso = () => new Date().toISOString();

const createStableId = (prefix: string) => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const sanitizeSegment = (value: string, fallback: string) => {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || fallback;
};

const extensionForFile = (fileName = "", blobType = "") => {
  const match = fileName.match(/\.([a-z0-9]{1,12})$/i);
  if (match) return match[1].toLowerCase();
  if (blobType.includes("webm")) return "webm";
  if (blobType.includes("quicktime")) return "mov";
  return "mp4";
};

const dataUrlToBlob = (dataUrl: string): Blob | null => {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  try {
    const mimeType = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || "";
    const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
};

const openLibraryDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available."));
      return;
    }
    const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(INDEX_STORE_NAME)) {
        db.createObjectStore(INDEX_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local library DB."));
  });

const runDbRequest = <T>(
  storeName: string,
  mode: IDBTransactionMode,
  operate: (store: IDBObjectStore) => IDBRequest
): Promise<T> =>
  openLibraryDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = operate(store);
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => db.close();
      })
  );

const writeJsonFile = async (
  directory: FileSystemDirectoryHandle,
  fileName: string,
  value: unknown
) => {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
};

const writeBlobFile = async (
  directory: FileSystemDirectoryHandle,
  fileName: string,
  value: Blob
) => {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(value);
  await writable.close();
};

const readJsonFile = async <T>(
  directory: FileSystemDirectoryHandle,
  fileName: string
): Promise<T | null> => {
  try {
    const fileHandle = await directory.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
};

const getStoredRootHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  try {
    const handle = await runDbRequest<FileSystemDirectoryHandle | undefined>(
      HANDLE_STORE_NAME,
      "readonly",
      (store) => store.get(ROOT_HANDLE_KEY)
    );
    return handle || null;
  } catch {
    return null;
  }
};

const storeRootHandle = (handle: FileSystemDirectoryHandle) =>
  runDbRequest<void>(HANDLE_STORE_NAME, "readwrite", (store) =>
    store.put(handle, ROOT_HANDLE_KEY)
  );

const putIndexEntry = (entry: LocalVideoLibraryIndexEntry) =>
  runDbRequest<void>(INDEX_STORE_NAME, "readwrite", (store) =>
    store.put(entry, `${INDEX_KEY_PREFIX}${entry.analysisId}`)
  );

const listIndexEntries = async (): Promise<LocalVideoLibraryIndexEntry[]> => {
  try {
    const entries = await runDbRequest<LocalVideoLibraryIndexEntry[]>(
      INDEX_STORE_NAME,
      "readonly",
      (store) => store.getAll()
    );
    return (entries || []).filter((entry) => entry && entry.analysisId);
  } catch {
    return [];
  }
};

export const isFileSystemAccessSupported = () =>
  typeof window !== "undefined" &&
  typeof (window as WindowWithFileSystemAccess).showDirectoryPicker === "function";

const getPermission = async (
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

const getOrCreateRootManifest = async (
  root: FileSystemDirectoryHandle
): Promise<LocalVideoLibraryManifest> => {
  const existing = await readJsonFile<LocalVideoLibraryManifest>(root, LIBRARY_MANIFEST_FILE);
  const now = nowIso();
  const manifest: LocalVideoLibraryManifest =
    existing?.version === 1 && existing.app === "clarity-booking" && existing.libraryId
      ? { ...existing, updatedAt: existing.updatedAt || now }
      : {
          version: 1,
          libraryId: createStableId(ROOT_MANIFEST_ID_PREFIX),
          createdAt: now,
          updatedAt: now,
          app: "clarity-booking",
        };
  await writeJsonFile(root, LIBRARY_MANIFEST_FILE, {
    ...manifest,
    updatedAt: now,
  });
  return manifest;
};

const getAnalysisDirectory = async (
  root: FileSystemDirectoryHandle,
  playerId: string,
  analysisId: string,
  create: boolean
) => {
  const playersDirectory = await root.getDirectoryHandle("players", { create });
  const playerDirectory = await playersDirectory.getDirectoryHandle(
    sanitizeSegment(playerId, "player"),
    { create }
  );
  const analysesDirectory = await playerDirectory.getDirectoryHandle("analyses", {
    create,
  });
  return analysesDirectory.getDirectoryHandle(sanitizeSegment(analysisId, "analysis"), {
    create,
  });
};

const buildAnalysisManifest = (
  args: SaveManagedLocalProjectArgs,
  indexEntry: LocalVideoLibraryIndexEntry
) => ({
  version: 1,
  app: "clarity-booking",
  analysisId: indexEntry.analysisId,
  playerId: indexEntry.playerId,
  playerName: indexEntry.playerName,
  lessonId: indexEntry.lessonId,
  lessonTitle: indexEntry.lessonTitle,
  title: indexEntry.title,
  createdAt: indexEntry.createdAt,
  updatedAt: indexEntry.updatedAt,
  videos: indexEntry.videos,
  workspaceFile: "workspace.json",
  analysisFile: "analysis.json",
  snapshotsDirectory: "snapshots",
  source: args.artifact.backend,
});

export const getLocalVideoLibraryStatus = async (): Promise<LocalVideoLibraryStatus> => {
  if (!isFileSystemAccessSupported()) {
    return {
      supported: false,
      configured: false,
      permission: "unsupported",
      mode: "browser-bound",
      message: "File System Access is unavailable. Videos stay browser-bound on this device.",
    };
  }

  const handle = await getStoredRootHandle();
  if (!handle) {
    return {
      supported: true,
      configured: false,
      permission: "unknown",
      mode: "managed-folder",
      message: "Choose Clarity Video Library",
    };
  }

  const permission = await getPermission(handle);
  return {
    supported: true,
    configured: true,
    permission,
    mode: "managed-folder",
    message:
      permission === "granted"
        ? "Local video library connected"
        : "Reconnect the local video library to continue using managed files.",
  };
};

export const chooseLocalVideoLibrary = async (): Promise<LocalVideoLibraryStatus> => {
  const picker = (window as WindowWithFileSystemAccess).showDirectoryPicker;
  if (!picker) return getLocalVideoLibraryStatus();
  const handle = await picker({
    id: "clarity-video-library",
    mode: "readwrite",
    startIn: "documents",
  });
  await storeRootHandle(handle);
  await getOrCreateRootManifest(handle);
  return getLocalVideoLibraryStatus();
};

export const reconnectLocalVideoLibrary = async (): Promise<LocalVideoLibraryStatus> => {
  const handle = await getStoredRootHandle();
  if (handle) {
    await getPermission(handle, true);
    return getLocalVideoLibraryStatus();
  }
  return chooseLocalVideoLibrary();
};

export const listLocalVideoLibraryProjects = async (): Promise<LocalVideoLibraryIndexEntry[]> => {
  const status = await getLocalVideoLibraryStatus();
  const availability: LocalLibraryAvailability =
    status.supported && status.configured && status.permission === "granted"
      ? "available"
      : status.supported && status.configured
        ? "needs-reconnect"
        : "fallback";
  return (await listIndexEntries()).map((entry) => ({
    ...entry,
    availability,
  }));
};

export const saveManagedLocalProject = async (
  args: SaveManagedLocalProjectArgs
): Promise<LocalVideoLibraryIndexEntry | null> => {
  const root = await getStoredRootHandle();
  if (!root || (await getPermission(root, true)) !== "granted") {
    return null;
  }

  const artifact = args.artifact;
  const now = nowIso();
  await getOrCreateRootManifest(root);

  const analysisId = artifact.analyses.left.id || createStableId("analysis");
  const playerDirectory = await root
    .getDirectoryHandle("players", { create: true })
    .then((playersDirectory) =>
      playersDirectory.getDirectoryHandle(sanitizeSegment(artifact.playerId, "player"), {
        create: true,
      })
    );
  await writeJsonFile(playerDirectory, "player.json", {
    version: 1,
    playerId: artifact.playerId,
    playerName: args.playerName,
    updatedAt: now,
  });

  const analysisDirectory = await getAnalysisDirectory(
    root,
    artifact.playerId,
    analysisId,
    true
  );
  const videosDirectory = await analysisDirectory.getDirectoryHandle("videos", {
    create: true,
  });
  const snapshotsDirectory = await analysisDirectory.getDirectoryHandle("snapshots", {
    create: true,
  });

  const indexedVideos = await Promise.all(
    (["left", "right"] as ComparisonSide[]).map(async (side) => {
      const video = args.videos[side];
      if (!video) return null;
      const stored = await fallbackVideoStore?.getVideo(
        buildVideoSlotKey(artifact.playerId, side, artifact.lessonId)
      );
      if (!stored) return [side, video] as const;
      const extension = extensionForFile(video.title, stored.blob.type);
      const fileName = `${side}.${extension}`;
      await writeBlobFile(videosDirectory, fileName, stored.blob);
      return [side, { ...video, fileName }] as const;
    })
  );

  const indexVideos = indexedVideos.reduce<LocalVideoLibraryIndexEntry["videos"]>(
    (accumulator, entry) => {
      if (!entry) return accumulator;
      accumulator[entry[0]] = entry[1];
      return accumulator;
    },
    {}
  );

  const writeSnapshots = async (analysis: VideoAnalysis) => {
    await Promise.all(
      (analysis.focusSnapshots || []).map(async (snapshot) => {
        const blob = dataUrlToBlob(snapshot.imageDataUrl);
        if (!blob) return;
        await writeBlobFile(
          snapshotsDirectory,
          `${sanitizeSegment(snapshot.id, "snapshot")}.png`,
          blob
        );
      })
    );
  };

  await Promise.all([
    writeSnapshots(artifact.analyses.left),
    writeSnapshots(artifact.analyses.right),
  ]);

  const title =
    args.lessonTitle ||
    artifact.analyses.left.title ||
    artifact.analyses.right.title ||
    "Video analysis";
  const thumbnailDataUrl =
    artifact.analyses.left.focusSnapshots?.[0]?.imageDataUrl ||
    artifact.analyses.right.focusSnapshots?.[0]?.imageDataUrl;
  const createdAt = artifact.analyses.left.createdAt || artifact.savedAt;
  const indexEntry: LocalVideoLibraryIndexEntry = {
    version: 1,
    analysisId,
    playerId: artifact.playerId,
    playerName: args.playerName,
    lessonId: artifact.lessonId,
    lessonTitle: args.lessonTitle,
    title,
    createdAt,
    updatedAt: now,
    thumbnailDataUrl,
    videos: indexVideos,
    availability: "available",
  };

  await Promise.all([
    writeJsonFile(analysisDirectory, "analysis.json", artifact.analyses),
    writeJsonFile(analysisDirectory, "workspace.json", artifact.workspace),
  ]);
  await writeJsonFile(analysisDirectory, "manifest.json", buildAnalysisManifest(args, indexEntry));
  await putIndexEntry(indexEntry);
  await getOrCreateRootManifest(root);

  return indexEntry;
};

export const createManagedLocalVideoStore = (): VideoBlobStore | null => {
  if (!fallbackVideoStore) return null;
  return {
    async putVideo(slotKey, video, blob) {
      await fallbackVideoStore.putVideo(slotKey, video, blob);
    },
    async getVideo(slotKey): Promise<StoredVideo | null> {
      return fallbackVideoStore.getVideo(slotKey);
    },
    async removeVideo(slotKey) {
      await fallbackVideoStore.removeVideo(slotKey);
    },
    async listVideoMeta() {
      const [fallbackMeta, libraryEntries] = await Promise.all([
        fallbackVideoStore.listVideoMeta(),
        listLocalVideoLibraryProjects(),
      ]);
      const libraryMeta = libraryEntries.flatMap((entry) =>
        (["left", "right"] as ComparisonSide[])
          .map((side) => entry.videos[side])
          .filter((video): video is PlayerVideo => Boolean(video))
      );
      const byId = new Map<string, PlayerVideo>();
      [...fallbackMeta, ...libraryMeta].forEach((video) => byId.set(video.id, video));
      return Array.from(byId.values());
    },
  };
};
