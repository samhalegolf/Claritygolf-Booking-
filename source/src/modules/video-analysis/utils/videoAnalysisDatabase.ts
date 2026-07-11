export const VIDEO_ANALYSIS_DB_NAME = "clarity-video-analysis";
export const VIDEO_ANALYSIS_DB_VERSION = 3;

export const VIDEO_ANALYSIS_DB_STORES = {
  transientVideos: "videos",
  savedVideoItems: "savedVideoItems",
  savedVideoBlobs: "savedVideoBlobs",
  managedLocalLibrary: "managedLocalLibrary",
} as const;

export type VideoAnalysisObjectStoreName =
  (typeof VIDEO_ANALYSIS_DB_STORES)[keyof typeof VIDEO_ANALYSIS_DB_STORES];

export type IndexedDbSafeErrorCode =
  | "INDEXEDDB_OPEN_FAILED"
  | "INDEXEDDB_OPEN_BLOCKED"
  | "INDEXEDDB_VERSION_REGRESSION";

export interface IndexedDbOpenDiagnostics {
  databaseName: string;
  requestedVersion: number;
  detectedCurrentVersion: number | null;
  operation: string;
  safeErrorCode: IndexedDbSafeErrorCode;
}

export class VideoAnalysisIndexedDbError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: IndexedDbOpenDiagnostics,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "VideoAnalysisIndexedDbError";
  }
}

export const getVideoAnalysisDatabaseStoreNames = (): VideoAnalysisObjectStoreName[] =>
  Object.values(VIDEO_ANALYSIS_DB_STORES);

export const isIndexedDbFactoryAvailable = () =>
  (typeof indexedDB !== "undefined" && indexedDB !== null) ||
  (typeof window !== "undefined" &&
    typeof window.indexedDB !== "undefined" &&
    window.indexedDB !== null);

const resolveIndexedDbFactory = (): IDBFactory => {
  if (typeof indexedDB !== "undefined" && indexedDB !== null) return indexedDB;
  if (typeof window !== "undefined" && window.indexedDB) return window.indexedDB;
  throw new Error("IndexedDB is not available in this browser.");
};

const detectIndexedDbDatabaseVersion = async (databaseName: string): Promise<number | null> => {
  try {
    const factory = resolveIndexedDbFactory() as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string; version?: number }>>;
    };
    if (typeof factory.databases !== "function") return null;
    const databases = await factory.databases();
    const match = databases.find((database) => database.name === databaseName);
    return typeof match?.version === "number" ? match.version : null;
  } catch {
    return null;
  }
};

const safeCodeForError = (error: unknown): IndexedDbSafeErrorCode => {
  if (error instanceof DOMException && error.name === "VersionError") {
    return "INDEXEDDB_VERSION_REGRESSION";
  }
  return "INDEXEDDB_OPEN_FAILED";
};

const createOpenError = async (
  databaseName: string,
  requestedVersion: number,
  operation: string,
  error: unknown,
  safeErrorCode = safeCodeForError(error)
) => {
  const diagnostics: IndexedDbOpenDiagnostics = {
    databaseName,
    requestedVersion,
    detectedCurrentVersion: await detectIndexedDbDatabaseVersion(databaseName),
    operation,
    safeErrorCode,
  };
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn("video_analysis_indexeddb_open_failed", diagnostics);
  }
  const message =
    safeErrorCode === "INDEXEDDB_VERSION_REGRESSION"
      ? "IndexedDB schema version regression while opening video analysis storage."
      : "Could not open video analysis IndexedDB storage.";
  return new VideoAnalysisIndexedDbError(message, diagnostics, error);
};

export const ensureVideoAnalysisDatabaseStores = (db: IDBDatabase) => {
  if (!db.objectStoreNames.contains(VIDEO_ANALYSIS_DB_STORES.transientVideos)) {
    db.createObjectStore(VIDEO_ANALYSIS_DB_STORES.transientVideos);
  }
  if (!db.objectStoreNames.contains(VIDEO_ANALYSIS_DB_STORES.savedVideoItems)) {
    db.createObjectStore(VIDEO_ANALYSIS_DB_STORES.savedVideoItems, {
      keyPath: "savedVideoId",
    });
  }
  if (!db.objectStoreNames.contains(VIDEO_ANALYSIS_DB_STORES.savedVideoBlobs)) {
    db.createObjectStore(VIDEO_ANALYSIS_DB_STORES.savedVideoBlobs, {
      keyPath: "savedVideoId",
    });
  }
  if (!db.objectStoreNames.contains(VIDEO_ANALYSIS_DB_STORES.managedLocalLibrary)) {
    db.createObjectStore(VIDEO_ANALYSIS_DB_STORES.managedLocalLibrary);
  }
};

export const openIndexedDbDatabase = ({
  databaseName,
  version,
  operation,
  onUpgradeNeeded,
}: {
  databaseName: string;
  version: number;
  operation: string;
  onUpgradeNeeded: (db: IDBDatabase, event: IDBVersionChangeEvent) => void;
}): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown, safeErrorCode?: IndexedDbSafeErrorCode) => {
      if (settled) return;
      settled = true;
      void createOpenError(databaseName, version, operation, error, safeErrorCode).then(reject);
    };

    let request: IDBOpenDBRequest;
    try {
      request = resolveIndexedDbFactory().open(databaseName, version);
    } catch (error) {
      fail(error);
      return;
    }

    request.onupgradeneeded = (event) => {
      onUpgradeNeeded(request.result, event);
    };
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      fail(request.error || new Error("IndexedDB open request failed."));
    };
    request.onblocked = () => {
      fail(new Error("IndexedDB open request was blocked by another tab."), "INDEXEDDB_OPEN_BLOCKED");
    };
  });

export const openVideoAnalysisDatabase = (operation: string): Promise<IDBDatabase> =>
  openIndexedDbDatabase({
    databaseName: VIDEO_ANALYSIS_DB_NAME,
    version: VIDEO_ANALYSIS_DB_VERSION,
    operation,
    onUpgradeNeeded: (db) => ensureVideoAnalysisDatabaseStores(db),
  });
