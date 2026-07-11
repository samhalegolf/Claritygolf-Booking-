import { VideoAnalysis } from "../models/Analysis";
import { FocusAreaRect, FocusMode } from "../models/Focus";
import {
  VideoBlobStore,
  createIndexedDbVideoStore,
} from "./videoBlobStore";
import { openIndexedDbDatabase } from "./videoAnalysisDatabase";

const ANALYSIS_PREFIX = "clarity.video.analysis";
const WORKSPACE_PREFIX = "clarity.video.workspace";
const ARTIFACT_PREFIX = "clarity.video.artifact";
const DEVICE_DB_NAME = "clarity-video-analysis-device";
const DEVICE_DB_VERSION = 1;
const DEVICE_STORE_NAME = "keyValue";

type MaybePromise<T> = T | Promise<T>;

export interface PersistenceAdapter {
  getItem(key: string): MaybePromise<string | null>;
  setItem(key: string, value: string): MaybePromise<void>;
  removeItem(key: string): MaybePromise<void>;
}

export interface WorkspacePersistenceContext {
  playerId?: string;
  lessonId?: string;
}

export interface VideoAnalysisPersistenceLayer {
  analysisAdapter: PersistenceAdapter;
  workspaceAdapter: PersistenceAdapter;
  // On-device blob store for the raw video files. Defaults to IndexedDB; may be
  // null when unavailable, and can be swapped for a cloud-backed store later.
  videoStore: VideoBlobStore | null;
}

const withFallbackAdapter = (
  adapter: PersistenceAdapter,
  fallback: PersistenceAdapter = browserStorageAdapter
): PersistenceAdapter => {
  return {
    getItem: async (key) => {
      try {
        const primaryValue = await adapter.getItem(key);
        if (primaryValue !== null) return primaryValue;
      } catch {
        // Fall back below.
      }
      return fallback.getItem(key);
    },
    setItem: async (key, value) => {
      try {
        await adapter.setItem(key, value);
        return;
      } catch {
        await fallback.setItem(key, value);
      }
    },
    removeItem: async (key) => {
      try {
        await adapter.removeItem(key);
      } finally {
        await fallback.removeItem(key);
      }
    },
  };
};

export const createVideoAnalysisPersistence = (
  adapters: Partial<VideoAnalysisPersistenceLayer> = {}
): VideoAnalysisPersistenceLayer => ({
  analysisAdapter: adapters.analysisAdapter
    ? withFallbackAdapter(adapters.analysisAdapter)
    : withFallbackAdapter(indexedDbStorageAdapter),
  workspaceAdapter: adapters.workspaceAdapter
    ? withFallbackAdapter(adapters.workspaceAdapter)
    : withFallbackAdapter(indexedDbStorageAdapter),
  videoStore:
    adapters.videoStore !== undefined
      ? adapters.videoStore
      : createIndexedDbVideoStore(),
});

export type WorkspaceMode = "single" | "compare";
export type ComparisonSide = "left" | "right";

export interface ComparisonWorkspaceState {
  version: 1;
  mode: WorkspaceMode;
  activeSide: ComparisonSide;
  savedVideoIds?: Partial<Record<ComparisonSide, string>>;
  linkedPlayback: boolean;
  focusWindowOpen: boolean;
  focusWindowMode: FocusMode;
  focusWindowSide: ComparisonSide;
  focusAreaRect: FocusAreaRect | null;
}

export type SaveBackend = "local-device" | "cloud-service";

export interface VideoAnalysisSaveArtifact {
  version: 1;
  savedAt: string;
  backend: SaveBackend;
  playerId: string;
  lessonId?: string;
  workspace: ComparisonWorkspaceState;
  analyses: {
    left: VideoAnalysis;
    right: VideoAnalysis;
  };
}

export class PersistenceQuotaError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PersistenceQuotaError";
  }
}

const isQuotaError = (error: unknown): boolean => {
  if (!(error instanceof DOMException)) return false;
  // Different browsers report quota overflow under different names/codes.
  return (
    error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error.code === 22 ||
    error.code === 1014
  );
};

export const browserStorageAdapter: PersistenceAdapter = {
  getItem: (key) => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      if (isQuotaError(error)) {
        // Surface a typed error so callers can warn the user rather than
        // crashing an effect. Snapshots embed base64 images and fill the ~5MB
        // localStorage budget quickly.
        throw new PersistenceQuotaError(
          "Local storage is full; recent changes could not be saved.",
          error
        );
      }
      throw error;
    }
  },
  removeItem: (key) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore removal failures.
    }
  },
};

let indexedDbOpenPromise: Promise<IDBDatabase> | null = null;

const openIndexedDb = () => {
  if (indexedDbOpenPromise) return indexedDbOpenPromise;
  indexedDbOpenPromise = openIndexedDbDatabase({
    databaseName: DEVICE_DB_NAME,
    version: DEVICE_DB_VERSION,
    operation: "analysis-persistence.key-value.open",
    onUpgradeNeeded: (db) => {
      if (!db.objectStoreNames.contains(DEVICE_STORE_NAME)) {
        db.createObjectStore(DEVICE_STORE_NAME);
      }
    },
  });
  return indexedDbOpenPromise;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });

const runIndexedDbStore = async <T>(
  mode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openIndexedDb();
  const transaction = db.transaction(DEVICE_STORE_NAME, mode);
  const store = transaction.objectStore(DEVICE_STORE_NAME);
  return requestResult(callback(store));
};

export const indexedDbStorageAdapter: PersistenceAdapter = {
  getItem: async (key) => {
    const value = await runIndexedDbStore("readonly", (store) => store.get(key));
    return typeof value === "string" ? value : null;
  },
  setItem: async (key, value) => {
    await runIndexedDbStore("readwrite", (store) => store.put(value, key));
  },
  removeItem: async (key) => {
    await runIndexedDbStore("readwrite", (store) => store.delete(key));
  },
};

export const buildAnalysisKey = (playerId: string, videoId: string, lessonId?: string) =>
  `${ANALYSIS_PREFIX}.${playerId}.${lessonId ?? "default"}.${videoId}`;

export const saveAnalysis = (
  analysis: VideoAnalysis,
  adapter: PersistenceAdapter = indexedDbStorageAdapter,
  storageVideoId = analysis.videoId
) => {
  const key = buildAnalysisKey(
    analysis.playerId,
    storageVideoId,
    analysis.lessonId
  );
  return adapter.setItem(key, JSON.stringify(analysis));
};

export const loadAnalysis = async (
  playerId: string,
  videoId: string,
  lessonId?: string,
  adapter: PersistenceAdapter = indexedDbStorageAdapter
): Promise<VideoAnalysis | null> => {
  const key = buildAnalysisKey(playerId, videoId, lessonId);
  const raw = await adapter.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VideoAnalysis;
  } catch {
    return null;
  }
};

export const clearAnalysis = (
  playerId: string,
  videoId: string,
  lessonId?: string,
  adapter: PersistenceAdapter = indexedDbStorageAdapter
) => {
  return adapter.removeItem(buildAnalysisKey(playerId, videoId, lessonId));
};

const sanitizeFocusAreaRect = (raw: unknown): FocusAreaRect | null => {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return null;
  if (
    typeof candidate.width !== "number" ||
    typeof candidate.height !== "number" ||
    !Number.isFinite(candidate.x) ||
    !Number.isFinite(candidate.y) ||
    !Number.isFinite(candidate.width) ||
    !Number.isFinite(candidate.height)
  ) {
    return null;
  }
  return {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  };
};

const sanitizeWorkspaceState = (raw: unknown): ComparisonWorkspaceState | null => {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const mode = candidate.mode === "compare" || candidate.mode === "single" ? candidate.mode : "single";
  const activeSide = candidate.activeSide === "right" ? "right" : "left";
  const linkedRaw = candidate.linkedPlayback;
  const linkedPlayback = linkedRaw === true || linkedRaw === false ? linkedRaw : false;
  const focusWindowRaw = candidate.focusWindowOpen;
  const focusWindowOpen = focusWindowRaw === true || focusWindowRaw === false ? focusWindowRaw : false;
  const focusWindowMode =
    candidate.focusWindowMode === "track" ? "track" : "area";
  const focusWindowSide = candidate.focusWindowSide === "right" ? "right" : "left";
  const focusAreaRect = sanitizeFocusAreaRect(candidate.focusAreaRect);
  const savedVideoIdsCandidate = candidate.savedVideoIds;
  const savedVideoIds =
    savedVideoIdsCandidate && typeof savedVideoIdsCandidate === "object"
      ? {
          left:
            typeof (savedVideoIdsCandidate as Record<string, unknown>).left === "string"
              ? ((savedVideoIdsCandidate as Record<string, string>).left)
              : undefined,
          right:
            typeof (savedVideoIdsCandidate as Record<string, unknown>).right === "string"
              ? ((savedVideoIdsCandidate as Record<string, string>).right)
              : undefined,
        }
      : undefined;

  return {
    version: 1,
    mode,
    activeSide,
    savedVideoIds,
    linkedPlayback,
    focusWindowOpen,
    focusWindowMode,
    focusWindowSide,
    focusAreaRect,
  };
};

const getWorkspaceKey = (context?: WorkspacePersistenceContext) => {
  if (!context?.playerId && !context?.lessonId) {
    return `${WORKSPACE_PREFIX}.comparison`;
  }

  return `${WORKSPACE_PREFIX}.comparison.${context.playerId ?? "global"}.${context.lessonId ?? "default"}`;
};

export const saveComparisonWorkspaceState = (
  state: ComparisonWorkspaceState,
  adapter: PersistenceAdapter = indexedDbStorageAdapter,
  context?: WorkspacePersistenceContext
) => {
  const safeState: ComparisonWorkspaceState = {
    version: 1,
    mode: state.mode,
    activeSide: state.activeSide === "right" ? "right" : "left",
    savedVideoIds: {
      left: state.savedVideoIds?.left,
      right: state.savedVideoIds?.right,
    },
    linkedPlayback: state.linkedPlayback === true,
    focusWindowOpen: state.focusWindowOpen === true,
    focusWindowMode: state.focusWindowMode === "track" ? "track" : "area",
    focusWindowSide: state.focusWindowSide === "right" ? "right" : "left",
    focusAreaRect: state.focusAreaRect && state.focusAreaRect.width > 0 && state.focusAreaRect.height > 0
      ? state.focusAreaRect
      : null,
  };
  return adapter.setItem(getWorkspaceKey(context), JSON.stringify(safeState));
};

export const loadComparisonWorkspaceState = async (
  adapter: PersistenceAdapter = indexedDbStorageAdapter,
  context?: WorkspacePersistenceContext
): Promise<ComparisonWorkspaceState | null> => {
  const raw = await adapter.getItem(getWorkspaceKey(context));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeWorkspaceState(parsed);
  } catch {
    return null;
  }
};

export const clearComparisonWorkspaceState = (
  adapter: PersistenceAdapter = indexedDbStorageAdapter,
  context?: WorkspacePersistenceContext
) => {
  return adapter.removeItem(getWorkspaceKey(context));
};

const getArtifactKey = (context: WorkspacePersistenceContext) =>
  `${ARTIFACT_PREFIX}.${context.playerId ?? "global"}.${context.lessonId ?? "default"}`;

export const saveVideoAnalysisArtifactToDevice = (
  artifact: VideoAnalysisSaveArtifact,
  adapter: PersistenceAdapter = indexedDbStorageAdapter
) => {
  return adapter.setItem(
    getArtifactKey({ playerId: artifact.playerId, lessonId: artifact.lessonId }),
    JSON.stringify(artifact)
  );
};

export const saveVideoAnalysisArtifactToCloud = async () => {
  throw new Error("Cloud video transfer is disabled until the saved-video Drive adapter is implemented.");
};
