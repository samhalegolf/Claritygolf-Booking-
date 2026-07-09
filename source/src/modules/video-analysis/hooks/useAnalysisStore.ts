import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createId } from "../utils/frameMath";
import { AnalysisStoreEngine } from "../engines/AnalysisStore";
import { FocusSnapshot, VideoAnalysis } from "../models/Analysis";
import { FriendlyMarkerLabel, TimelineMarker } from "../models/Timeline";
import { DrawingObject } from "../models/Drawing";
import type { FocusAreaRect } from "../models/Focus";
import { PersistenceAdapter, PersistenceQuotaError } from "../utils/localPersistence";

const SAVE_DEBOUNCE_MS = 400;

export interface UseAnalysisStoreArgs {
  playerId: string;
  lessonId?: string;
  videoId: string | null;
  persistenceAdapter?: PersistenceAdapter;
}

export interface UseAnalysisStoreResult {
  analysis: VideoAnalysis;
  updateAnalysis: (patch: Partial<VideoAnalysis>) => void;
  setMarkers: (markers: TimelineMarker[]) => void;
  setDrawings: (drawings: DrawingObject[]) => void;
  persistenceError: string | null;
  saveNow: () => Promise<boolean>;
}

const createBlankAnalysis = (
  playerId: string,
  videoId: string,
  lessonId?: string
): VideoAnalysis => ({
  id: createId("analysis"),
  playerId,
  lessonId,
  videoId,
  videoMeta: undefined,
  drawings: [],
  markers: [],
  notes: [],
  focusViews: [],
  focusSnapshots: [],
  narrationRefs: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const sanitizeFriendlyLabel = (label: unknown): FriendlyMarkerLabel => {
  if (typeof label === "string") {
    const allowed = [
      "Setup",
      "Takeaway",
      "Top",
      "Delivery",
      "Impact",
      "Finish",
    ];
    if (allowed.includes(label)) return label as FriendlyMarkerLabel;
  }
  return "Setup";
};

const sanitizeMarker = (raw: unknown): TimelineMarker | null => {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== "string") return null;
  const time = typeof candidate.time === "number" ? candidate.time : Number(candidate.time);
  if (!Number.isFinite(time)) return null;
  return {
    id: candidate.id,
    label: sanitizeFriendlyLabel(candidate.label),
    time: Math.max(0, time),
    color: typeof candidate.color === "string" ? candidate.color : undefined,
    thumbnail:
      typeof candidate.thumbnail === "string" && candidate.thumbnail.length ? candidate.thumbnail : undefined,
  };
};

const sanitizeMarkers = (raw: unknown): TimelineMarker[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeMarker).filter(Boolean) as TimelineMarker[];
};

const sanitizeDrawings = (raw: unknown): DrawingObject[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.type === "string" &&
      ["line", "angle", "circle", "pen"].includes(candidate.type as string)
    );
  }) as DrawingObject[];
};

const sanitizeFocusAreaRect = (raw: unknown): FocusAreaRect | null => {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.x !== "number" ||
    typeof candidate.y !== "number" ||
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

const sanitizeFocusSnapshotSourceMeta = (
  raw: unknown
): {
  fps?: number;
  duration?: number;
  width?: number;
  height?: number;
} | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  return {
    fps: typeof candidate.fps === "number" ? candidate.fps : undefined,
    duration: typeof candidate.duration === "number" ? candidate.duration : undefined,
    width: typeof candidate.width === "number" ? candidate.width : undefined,
    height: typeof candidate.height === "number" ? candidate.height : undefined,
  };
};

const sanitizeFocusSnapshotSourceImageMeta = (
  raw: unknown
):
  | {
      sourceWidth?: number;
      sourceHeight?: number;
      sourceCropRect?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      imageWidth?: number;
      imageHeight?: number;
      capturedFromSource?: boolean;
    }
  | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const sourceCropRectCandidate = candidate.sourceCropRect;
  let sourceCropRect:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | undefined;
  if (sourceCropRectCandidate && typeof sourceCropRectCandidate === "object") {
    const safeCandidate = sourceCropRectCandidate as Record<string, unknown>;
    const sourceCropRectX = safeCandidate.x;
    const sourceCropRectY = safeCandidate.y;
    const sourceCropRectWidth = safeCandidate.width;
    const sourceCropRectHeight = safeCandidate.height;
    if (
      typeof sourceCropRectX === "number" &&
      typeof sourceCropRectY === "number" &&
      typeof sourceCropRectWidth === "number" &&
      typeof sourceCropRectHeight === "number"
    ) {
      sourceCropRect = {
        x: sourceCropRectX,
        y: sourceCropRectY,
        width: sourceCropRectWidth,
        height: sourceCropRectHeight,
      };
    }
  }

  return {
    sourceWidth: typeof candidate.sourceWidth === "number" ? candidate.sourceWidth : undefined,
    sourceHeight: typeof candidate.sourceHeight === "number" ? candidate.sourceHeight : undefined,
    sourceCropRect,
    imageWidth: typeof candidate.imageWidth === "number" ? candidate.imageWidth : undefined,
    imageHeight: typeof candidate.imageHeight === "number" ? candidate.imageHeight : undefined,
    capturedFromSource:
      typeof candidate.capturedFromSource === "boolean" ? candidate.capturedFromSource : undefined,
  };
};

const sanitizeFocusSnapshot = (raw: unknown): FocusSnapshot | null => {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const cropRect = sanitizeFocusAreaRect(candidate.cropRect);
  if (!cropRect) return null;

  if (typeof candidate.id !== "string" || !candidate.id) return null;
  if (typeof candidate.playerId !== "string" || !candidate.playerId) return null;
  if (typeof candidate.analysisId !== "string" || !candidate.analysisId) return null;
  if (!Number.isFinite(typeof candidate.currentTime === "number" ? candidate.currentTime : Number(candidate.currentTime)))
    return null;
  if (typeof candidate.imageDataUrl !== "string" || !candidate.imageDataUrl) return null;
  const side = candidate.side === "right" ? "right" : "left";
  const currentTime =
    typeof candidate.currentTime === "number" ? candidate.currentTime : Number(candidate.currentTime);
  const currentFrame =
    typeof candidate.currentFrame === "number" ? candidate.currentFrame : Number(candidate.currentFrame);

  return {
    id: candidate.id,
    playerId: candidate.playerId,
    analysisId: candidate.analysisId,
    title:
      typeof candidate.title === "string" && candidate.title.length > 0
        ? candidate.title
        : "Focus snapshot",
    side,
    sourceVideoId:
      typeof candidate.sourceVideoId === "string" ? candidate.sourceVideoId : undefined,
    sourceVideoTitle:
      typeof candidate.sourceVideoTitle === "string" ? candidate.sourceVideoTitle : undefined,
    sourceVideoMeta: sanitizeFocusSnapshotSourceMeta(candidate.sourceVideoMeta),
    sourceImageMeta: sanitizeFocusSnapshotSourceImageMeta(candidate.sourceImageMeta),
    currentTime,
    currentFrame: Number.isFinite(currentFrame) ? currentFrame : 0,
    cropRect,
    imageDataUrl: candidate.imageDataUrl,
    createdAt:
      typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
  };
};

const sanitizeFocusSnapshots = (raw: unknown): FocusSnapshot[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeFocusSnapshot)
    .filter((entry): entry is FocusSnapshot => entry !== null);
};

const sanitizeAnalysis = (
  playerId: string,
  safeVideoId: string,
  lessonId: string | undefined,
  loaded: VideoAnalysis | null
): VideoAnalysis => {
  if (!loaded) return createBlankAnalysis(playerId, safeVideoId, lessonId);
  const fallback = createBlankAnalysis(playerId, safeVideoId, lessonId);
  // Protected boundary: sanitize persisted payloads before restoring to prevent malformed drafts from corrupting live state.
  return {
    ...fallback,
    ...loaded,
    videoMeta:
      loaded.videoMeta &&
      typeof loaded.videoMeta === "object" &&
      loaded.videoMeta !== null
        ? {
            title:
              typeof loaded.videoMeta.title === "string" ? loaded.videoMeta.title : fallback.videoMeta?.title,
            duration:
              typeof loaded.videoMeta.duration === "number" ? loaded.videoMeta.duration : undefined,
            fps: typeof loaded.videoMeta.fps === "number" ? loaded.videoMeta.fps : undefined,
            width: typeof loaded.videoMeta.width === "number" ? loaded.videoMeta.width : undefined,
            height: typeof loaded.videoMeta.height === "number" ? loaded.videoMeta.height : undefined,
          }
        : fallback.videoMeta,
    drawings: sanitizeDrawings(loaded.drawings),
    markers: sanitizeMarkers(loaded.markers),
    notes: Array.isArray(loaded.notes) ? loaded.notes : fallback.notes,
    focusViews: Array.isArray(loaded.focusViews) ? loaded.focusViews : fallback.focusViews,
    focusSnapshots: sanitizeFocusSnapshots(loaded.focusSnapshots),
    narrationRefs: Array.isArray(loaded.narrationRefs)
      ? loaded.narrationRefs
      : fallback.narrationRefs,
    createdAt: loaded.createdAt || fallback.createdAt,
    updatedAt: loaded.updatedAt || fallback.updatedAt,
    title: loaded.title,
  };
};

export function useAnalysisStore({
  playerId,
  lessonId,
  videoId,
  persistenceAdapter,
}: UseAnalysisStoreArgs): UseAnalysisStoreResult {
  const engine = useMemo(
    () => new AnalysisStoreEngine(persistenceAdapter),
    [persistenceAdapter]
  );
  const safeVideoId = videoId || "unspecified-video";
  const [analysis, setAnalysis] = useState<VideoAnalysis>(() =>
    createBlankAnalysis(playerId, safeVideoId, lessonId)
  );
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  // Mirror of the latest committed analysis so the debounced flush always
  // writes the most recent state without re-subscribing.
  const analysisRef = useRef(analysis);
  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePendingRef = useRef(false);

  const persistAnalysis = useCallback(
    async (nextAnalysis: VideoAnalysis): Promise<boolean> => {
      try {
        await engine.save(nextAnalysis, safeVideoId);
        setPersistenceError(null);
        return true;
      } catch (error) {
        if (error instanceof PersistenceQuotaError) {
          setPersistenceError(error.message);
        } else {
          setPersistenceError("Could not save analysis changes.");
          // Unexpected persistence failures should not crash the workspace.
          // eslint-disable-next-line no-console
          console.error("Failed to persist analysis", error);
        }
        return false;
      }
    },
    [engine, safeVideoId]
  );

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!savePendingRef.current) return true;
    const nextAnalysis = analysisRef.current;
    savePendingRef.current = false;
    return persistAnalysis(nextAnalysis);
  }, [persistAnalysis]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    savePendingRef.current = false;
    return persistAnalysis(analysisRef.current);
  }, [persistAnalysis]);

  const scheduleSave = useCallback(() => {
    savePendingRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Load persisted state. This uses setAnalysis directly and deliberately does
  // NOT schedule a save, so hydration never re-writes (or clobbers) storage.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await flushSave(); // persist any pending edits for the previous key first
      const loaded = await engine.load(playerId, safeVideoId, lessonId);
      if (cancelled) return;
      const nextAnalysis = sanitizeAnalysis(playerId, safeVideoId, lessonId, loaded);
      analysisRef.current = nextAnalysis;
      setAnalysis(nextAnalysis);
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, flushSave, lessonId, playerId, safeVideoId]);

  // Flush any pending write when the hook unmounts.
  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [flushSave]);

  const updateAnalysis = useCallback(
    (patch: Partial<VideoAnalysis>) => {
      setAnalysis((prev) => {
        const nextAnalysis = {
          ...prev,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        analysisRef.current = nextAnalysis;
        return nextAnalysis;
      });
      scheduleSave();
    },
    [scheduleSave]
  );

  const setMarkers = useCallback(
    (markers: TimelineMarker[]) => updateAnalysis({ markers }),
    [updateAnalysis]
  );

  const setDrawings = useCallback(
    (drawings: DrawingObject[]) => updateAnalysis({ drawings }),
    [updateAnalysis]
  );

  return {
    analysis,
    updateAnalysis,
    setMarkers,
    setDrawings,
    persistenceError,
    saveNow,
  };
}
