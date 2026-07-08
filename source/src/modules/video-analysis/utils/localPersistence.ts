import { VideoAnalysis } from "../models/Analysis";
import { FocusAreaRect, FocusMode } from "../models/Focus";
import {
  VideoBlobStore,
  createIndexedDbVideoStore,
} from "./videoBlobStore";

const ANALYSIS_PREFIX = "clarity.video.analysis";
const WORKSPACE_PREFIX = "clarity.video.workspace";

export interface PersistenceAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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

const withFallbackAdapter = (adapter: PersistenceAdapter | undefined): PersistenceAdapter => {
  if (!adapter) {
    return browserStorageAdapter;
  }

  return {
    getItem: (key) => {
      try {
        return adapter.getItem(key);
      } catch {
        return browserStorageAdapter.getItem(key);
      }
    },
    setItem: (key, value) => {
      try {
        adapter.setItem(key, value);
        return;
      } catch {
        browserStorageAdapter.setItem(key, value);
      }
    },
    removeItem: (key) => {
      try {
        adapter.removeItem(key);
        return;
      } catch {
        browserStorageAdapter.removeItem(key);
      }
    },
  };
};

export const createVideoAnalysisPersistence = (
  adapters: Partial<VideoAnalysisPersistenceLayer> = {}
): VideoAnalysisPersistenceLayer => ({
  analysisAdapter: withFallbackAdapter(adapters.analysisAdapter),
  workspaceAdapter: withFallbackAdapter(adapters.workspaceAdapter),
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
  linkedPlayback: boolean;
  focusWindowOpen: boolean;
  focusWindowMode: FocusMode;
  focusWindowSide: ComparisonSide;
  focusAreaRect: FocusAreaRect | null;
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

export const buildAnalysisKey = (playerId: string, videoId: string, lessonId?: string) =>
  `${ANALYSIS_PREFIX}.${playerId}.${lessonId ?? "default"}.${videoId}`;

export const saveAnalysis = (
  analysis: VideoAnalysis,
  adapter: PersistenceAdapter = browserStorageAdapter
) => {
  const key = buildAnalysisKey(
    analysis.playerId,
    analysis.videoId,
    analysis.lessonId
  );
  adapter.setItem(key, JSON.stringify(analysis));
};

export const loadAnalysis = (
  playerId: string,
  videoId: string,
  lessonId?: string,
  adapter: PersistenceAdapter = browserStorageAdapter
): VideoAnalysis | null => {
  const key = buildAnalysisKey(playerId, videoId, lessonId);
  const raw = adapter.getItem(key);
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
  adapter: PersistenceAdapter = browserStorageAdapter
) => {
  adapter.removeItem(buildAnalysisKey(playerId, videoId, lessonId));
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

  return {
    version: 1,
    mode,
    activeSide,
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
  adapter: PersistenceAdapter = browserStorageAdapter,
  context?: WorkspacePersistenceContext
) => {
  const safeState: ComparisonWorkspaceState = {
    version: 1,
    mode: state.mode,
    activeSide: state.activeSide === "right" ? "right" : "left",
    linkedPlayback: state.linkedPlayback === true,
    focusWindowOpen: state.focusWindowOpen === true,
    focusWindowMode: state.focusWindowMode === "track" ? "track" : "area",
    focusWindowSide: state.focusWindowSide === "right" ? "right" : "left",
    focusAreaRect: state.focusAreaRect && state.focusAreaRect.width > 0 && state.focusAreaRect.height > 0
      ? state.focusAreaRect
      : null,
  };
  adapter.setItem(getWorkspaceKey(context), JSON.stringify(safeState));
};

export const loadComparisonWorkspaceState = (
  adapter: PersistenceAdapter = browserStorageAdapter,
  context?: WorkspacePersistenceContext
): ComparisonWorkspaceState | null => {
  const raw = adapter.getItem(getWorkspaceKey(context));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeWorkspaceState(parsed);
  } catch {
    return null;
  }
};

export const clearComparisonWorkspaceState = (
  adapter: PersistenceAdapter = browserStorageAdapter,
  context?: WorkspacePersistenceContext
) => {
  adapter.removeItem(getWorkspaceKey(context));
};
