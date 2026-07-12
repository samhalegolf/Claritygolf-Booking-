import React, {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clamp, createId, FRAME_RATE_DEFAULT } from "./utils/frameMath";
import { videoAnalysisThemeCss } from "./theme/videoAnalysisTheme";
import { FocusPalette } from "./components/FocusPalette";
import { FocusWindow } from "./components/FocusWindow";
import { FocusAreaRect } from "./models/Focus";
import { FocusSnapshot, VideoAnalysis } from "./models/Analysis";
import { Inspector } from "./components/Inspector";
import { StatusBar } from "./components/StatusBar";
import { Timeline } from "./components/Timeline";
import { Toolbar } from "./components/Toolbar";
import { VideoCanvas } from "./components/VideoCanvas";
import { IconPlay, IconPause, IconRecord, IconUpload } from "./components/VideoIcons";
import {
  ComparisonSide,
  ComparisonWorkspaceState,
  VideoAnalysisPersistenceLayer,
  WorkspacePersistenceContext,
  clearComparisonWorkspaceState,
  createVideoAnalysisPersistence,
  loadComparisonWorkspaceState,
  saveComparisonWorkspaceState,
  WorkspaceMode,
} from "./utils/localPersistence";
import {
  buildVideoSlotKey,
  requestPersistentStorage,
} from "./utils/videoBlobStore";
import {
  createIndexedDbSavedVideoLibrary,
  importSavedVideoFromClarityCloud,
  SavedVideoCloudError,
  SavedVideoLibraryError,
  type SavedVideoItem,
  type SavedVideoLibraryStore,
} from "./utils/savedVideoLibrary";
import { useAnalysisStore } from "./hooks/useAnalysisStore";
import { useDrawing } from "./hooks/useDrawing";
import { useMarkerThumbnails } from "./hooks/useMarkerThumbnails";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { usePlayback } from "./hooks/usePlayback";
import { useTimeline } from "./hooks/useTimeline";
import { TimelineEngine } from "./engines/TimelineEngine";
import { PlayerVideo } from "./models/Video";
import { DrawingTool } from "./models/Drawing";
import { TimelineMarker } from "./models/Timeline";

const LEFT_ANALYSIS_SLOT = "comparison-left-slot";
const RIGHT_ANALYSIS_SLOT = "comparison-right-slot";

function getSideTitle(side: ComparisonSide) {
  return side === "left" ? "Left" : "Right";
}

function getSideLabel(side: ComparisonSide) {
  return side === "left" ? "L" : "R";
}

const MIN_ACTIVE_SELECTION_SIZE = 0.01;
const SNAPSHOT_STORAGE_WARNING_LIMIT = 12;
const SNAPSHOT_PREVIEW_WIDTH = 88;
const SNAPSHOT_PREVIEW_HEIGHT = 50;
const DEFAULT_PLAYER_ID = "player-demo-1";
type SaveStatus = "idle" | "saving" | "sending" | "downloading" | "saved" | "error";
type RecordingStatus = "ready" | "recording" | "processing" | "error";
type CloudUploadFailureStage =
  | "Configuration"
  | "Connection"
  | "Preparing storage"
  | "Starting upload"
  | "Uploading"
  | "Verifying";

interface CloudUploadFailureFeedback {
  title: "Cloud upload could not start";
  reason: string;
  stage: CloudUploadFailureStage;
  safeErrorCode: string;
  retryable?: boolean;
  httpStatus?: number;
  actionRequired: boolean;
}

export interface VideoWorkspaceNavigationContext {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  savedVideoId?: string;
  hasPlayerContext: boolean;
  reason: "toolbar-back" | "save" | "my-library-save";
}

export interface VideoWorkspaceSaveResult extends VideoWorkspaceNavigationContext {
  savedItems: SavedVideoItem[];
  reason: "save" | "my-library-save";
}

interface LiveRecordingSession {
  side: ComparisonSide;
  status: RecordingStatus;
  error: string | null;
  startedAt: number | null;
}

interface VideoWorkspaceProps {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  lessonTitle?: string;
  savedVideoId?: string;
  persistence?: Partial<VideoAnalysisPersistenceLayer>;
  savedVideoLibrary?: SavedVideoLibraryStore | null;
  onSavedVideoLibraryChange?: () => void;
  onNavigateBack?: (context: VideoWorkspaceNavigationContext) => void;
  onLocalSaveComplete?: (result: VideoWorkspaceSaveResult) => void | Promise<void>;
  onSaveAndSend?: (result: VideoWorkspaceSaveResult) => Promise<void>;
  onOpenCloudSettings?: () => void;
}

const cloudSettingsActionCodes = new Set([
  "CLOUD_OAUTH_NOT_CONFIGURED",
  "PROVIDER_STORAGE_UNAVAILABLE",
  "DRIVE_NOT_CONNECTED",
  "DRIVE_SCOPE_MISSING",
  "GOOGLE_RECONNECT_REQUIRED",
  "GOOGLE_TOKEN_REFRESH_FAILED",
]);

const cloudFailureStageFromPhase = (phase?: string): CloudUploadFailureStage | null => {
  if (phase === "preparing") return "Preparing storage";
  if (phase === "session-created") return "Starting upload";
  if (phase === "uploading") return "Uploading";
  if (phase === "verifying") return "Verifying";
  return null;
};

const cloudFailureStageFromCode = (code: string): CloudUploadFailureStage => {
  if (code === "CLOUD_OAUTH_NOT_CONFIGURED" || code === "PROVIDER_STORAGE_UNAVAILABLE") {
    return "Configuration";
  }
  if (
    code === "DRIVE_NOT_CONNECTED" ||
    code === "DRIVE_SCOPE_MISSING" ||
    code === "GOOGLE_RECONNECT_REQUIRED" ||
    code === "GOOGLE_TOKEN_REFRESH_FAILED" ||
    code === "CLARITY_CLOUD_PROVIDER_FAILED"
  ) {
    return "Connection";
  }
  if (code === "DRIVE_FOLDER_PROVISION_FAILED" || code === "DRIVE_TRANSFER_FOLDER_FAILED") {
    return "Preparing storage";
  }
  if (
    code === "DRIVE_UPLOAD_SESSION_FAILED" ||
    code === "DRIVE_TRANSFER_STATE_FAILED" ||
    code === "SAVED_VIDEO_BLOB_MISSING" ||
    code === "SAVED_VIDEO_SOURCE_MISSING"
  ) {
    return "Starting upload";
  }
  if (
    code === "DRIVE_UPLOAD_PROXY_FAILED" ||
    code === "DRIVE_UPLOAD_TOO_LARGE" ||
    code === "DRIVE_UPLOAD_SESSION_EXPIRED" ||
    code === "DRIVE_UPLOAD_INTERRUPTED" ||
    code === "TRANSFER_PAUSED" ||
    code === "TRANSFER_CANCELLED"
  ) {
    return "Uploading";
  }
  return "Verifying";
};

const stringProperty = (value: unknown, key: string) =>
  typeof value === "object" && value && key in value
    ? String((value as Record<string, unknown>)[key] || "")
    : "";

const cloudFailureCode = (error: unknown) =>
  error instanceof SavedVideoCloudError
    ? error.code
    : stringProperty(error, "code") || "CLARITY_CLOUD_TRANSFER_FAILED";

const buildCloudUploadFailureFeedback = (error: unknown): CloudUploadFailureFeedback => {
  const safeErrorCode = cloudFailureCode(error);
  const cloudError = error instanceof SavedVideoCloudError ? error : null;
  const stage =
    cloudFailureStageFromPhase(cloudError?.phase || stringProperty(error, "phase")) ||
    cloudFailureStageFromCode(safeErrorCode);
  const reason =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Your local video is safe. The cloud transfer service could not be reached.";

  return {
    title: "Cloud upload could not start",
    reason,
    stage,
    safeErrorCode,
    retryable: cloudError?.retryable,
    httpStatus: cloudError?.status,
    actionRequired: cloudSettingsActionCodes.has(safeErrorCode),
  };
};

const normalizePoint = (point: { x: number; y: number }, overlay: { width: number; height: number }) => ({
  x: clamp(point.x / Math.max(1, overlay.width), 0, 1),
  y: clamp(point.y / Math.max(1, overlay.height), 0, 1),
});

const toFixedTime = (value: number) => {
  const safeValue = Math.max(0, Number.isFinite(value) ? value : 0);
  const secondsTotal = Math.floor(safeValue);
  const minutes = Math.floor(secondsTotal / 60);
  const seconds = secondsTotal % 60;
  const millis = Math.max(0, Math.round((safeValue - secondsTotal) * 100));
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(2, "0")}`;
};

const getDataUrlBytes = (dataUrl: string) => {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return 0;
  const base64 = dataUrl.slice(commaIndex + 1);
  return Math.max(0, Math.floor((base64.length * 3) / 4));
};

const isDataUrl = (value: string) => typeof value === "string" && value.startsWith("data:image/");

const toDownloadFileName = (snapshot: FocusSnapshot) => {
  const safeTitle = snapshot.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `${safeTitle || "focus-snapshot"}-${snapshot.id}.png`;
};

const getSafeSourceDimensions = (
  sourceVideo: PlayerVideo,
  sourceVideoElement: HTMLVideoElement,
  playbackDimensions: { width: number; height: number }
) => {
  const fallbackWidth = Math.max(1, Math.round(playbackDimensions.width || 1));
  const fallbackHeight = Math.max(1, Math.round(playbackDimensions.height || 1));
  return {
    width: Math.max(1, Math.round(sourceVideoElement.videoWidth || sourceVideo.width || fallbackWidth)),
    height: Math.max(1, Math.round(sourceVideoElement.videoHeight || sourceVideo.height || fallbackHeight)),
  };
};

const buildSourceCropRect = (
  focusAreaRect: FocusAreaRect,
  sourceWidth: number,
  sourceHeight: number
) => {
  const safeSourceWidth = Math.max(1, Math.round(sourceWidth));
  const safeSourceHeight = Math.max(1, Math.round(sourceHeight));

  const sourceCropX = Math.floor(clamp(focusAreaRect.x, 0, 1) * safeSourceWidth);
  const sourceCropY = Math.floor(clamp(focusAreaRect.y, 0, 1) * safeSourceHeight);
  const sourceCropWidth = Math.max(
    1,
    Math.floor(clamp(focusAreaRect.width, 0, 1) * safeSourceWidth)
  );
  const sourceCropHeight = Math.max(
    1,
    Math.floor(clamp(focusAreaRect.height, 0, 1) * safeSourceHeight)
  );

  return {
    sourceWidth: safeSourceWidth,
    sourceHeight: safeSourceHeight,
    sourceCropRect: {
      x: clamp(sourceCropX, 0, safeSourceWidth - 1),
      y: clamp(sourceCropY, 0, safeSourceHeight - 1),
      width: clamp(
        sourceCropWidth,
        1,
        safeSourceWidth - clamp(sourceCropX, 0, safeSourceWidth - 1)
      ),
      height: clamp(
        sourceCropHeight,
        1,
        safeSourceHeight - clamp(sourceCropY, 0, safeSourceHeight - 1)
      ),
    },
  };
};

const createSourceImageMeta = (
  sourceWidth: number,
  sourceHeight: number,
  sourceCropRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
  capturedFromSource: boolean
) => {
  const isSourceCropValid = sourceCropRect.width > 0 && sourceCropRect.height > 0;
  return {
    sourceWidth,
    sourceHeight,
    sourceCropRect,
    imageWidth: isSourceCropValid ? sourceCropRect.width : undefined,
    imageHeight: isSourceCropValid ? sourceCropRect.height : undefined,
    capturedFromSource,
  };
};

const buildRectFromDrag = (
  start: { x: number; y: number },
  current: { x: number; y: number }
): FocusAreaRect => {
  const x = Math.min(start.x, current.x);
  const y = Math.min(start.y, current.y);
  return {
    x,
    y,
    width: Math.max(0, Math.max(start.x, current.x) - x),
    height: Math.max(0, Math.max(start.y, current.y) - y),
  };
};

const getPreferredRecordingMimeType = () => {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return (
    [
      "video/mp4;codecs=h264",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ""
  );
};

const getRecordingFileName = (side: ComparisonSide, mimeType: string) => {
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .replace("Z", "");
  return `live-recording-${side}-${timestamp}.${extension}`;
};

const hasSaveableAnalysisContent = (analysis: VideoAnalysis) => {
  return Boolean(
    analysis.videoMeta ||
      analysis.drawings.length ||
      analysis.focusSnapshots.length ||
      analysis.notes.length ||
      analysis.focusViews.length ||
      analysis.narrationRefs.length
  );
};

const briefSuccessDelay = () =>
  new Promise((resolve) => window.setTimeout(resolve, 450));

export function VideoWorkspace({
  playerId,
  playerName,
  lessonId,
  lessonTitle,
  savedVideoId,
  persistence,
  savedVideoLibrary,
  onSavedVideoLibraryChange,
  onNavigateBack,
  onLocalSaveComplete,
  onSaveAndSend,
  onOpenCloudSettings,
}: VideoWorkspaceProps) {
  const leftVideoRef = useRef<HTMLVideoElement>(null);
  const rightVideoRef = useRef<HTMLVideoElement>(null);
  const livePreviewRef = useRef<HTMLVideoElement>(null);
  const leftUploadInputRef = useRef<HTMLInputElement>(null);
  const rightUploadInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const resolvedPlayerId = playerId || DEFAULT_PLAYER_ID;
  const resolvedPlayerName = playerName || resolvedPlayerId;
  const persistenceLayer = useMemo(() => createVideoAnalysisPersistence(persistence), [persistence]);
  const defaultSavedVideoLibrary = useMemo(() => createIndexedDbSavedVideoLibrary(), []);
  const savedVideoStore = savedVideoLibrary === undefined ? defaultSavedVideoLibrary : savedVideoLibrary;
  const workspaceContext = useMemo<WorkspacePersistenceContext>(
    () => ({
      playerId: resolvedPlayerId,
      lessonId,
    }),
    [lessonId, resolvedPlayerId]
  );

  const leftPlayback = usePlayback({ videoRef: leftVideoRef });
  const rightPlayback = usePlayback({ videoRef: rightVideoRef });

  const stopLiveStream = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const [playerVideoLeft, setPlayerVideoLeft] = useState<PlayerVideo | null>(null);
  const [playerVideoRight, setPlayerVideoRight] = useState<PlayerVideo | null>(null);
  const [leftMountedSource, setLeftMountedSource] = useState<string | null>(null);
  const [rightMountedSource, setRightMountedSource] = useState<string | null>(null);
  const [cloudUploadFailure, setCloudUploadFailure] = useState<CloudUploadFailureFeedback | null>(null);
  const [leftOverlayDimensions, setLeftOverlayDimensions] = useState({
    width: 1,
    height: 1,
  });
  const [rightOverlayDimensions, setRightOverlayDimensions] = useState({
    width: 1,
    height: 1,
  });
  const [leftHoverMarker, setLeftHoverMarker] = useState<TimelineMarker | null>(null);
  const [rightHoverMarker, setRightHoverMarker] = useState<TimelineMarker | null>(null);
  const [focusPaletteOpen, setFocusPaletteOpen] = useState(false);
  const [showFocusWindow, setShowFocusWindow] = useState(false);
  const [focusWindowMode, setFocusWindowMode] = useState<"area" | "track">("area");
  const [focusWindowSide, setFocusWindowSide] = useState<ComparisonSide>("left");
  const [focusWindowHoverSide, setFocusWindowHoverSide] = useState<ComparisonSide | null>(null);
  const [focusSelectionMode, setFocusSelectionMode] = useState<"area" | "track" | null>(null);
  const [focusSelectionSide, setFocusSelectionSide] = useState<ComparisonSide>("left");
  const [focusSelectionStart, setFocusSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [focusSelectionDraft, setFocusSelectionDraft] = useState<FocusAreaRect | null>(null);
  const [focusAreaRect, setFocusAreaRect] = useState<FocusAreaRect | null>(null);
  const [focusArtifactExpandedId, setFocusArtifactExpandedId] = useState<string | null>(null);
  const [leftMetadataReady, setLeftMetadataReady] = useState(false);
  const [rightMetadataReady, setRightMetadataReady] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<WorkspaceMode>("single");
  const [linkedPlayback, setLinkedPlayback] = useState(false);
  const [activeSide, setActiveSide] = useState<ComparisonSide>("left");
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [currentSavedVideoIds, setCurrentSavedVideoIds] = useState<Partial<Record<ComparisonSide, string>>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveMessage, setSaveMessage] = useState("Nothing to save yet.");
  const [dragTargetSide, setDragTargetSide] = useState<ComparisonSide | null>(null);
  const [intakeError, setIntakeError] = useState("");
  const [liveRecording, setLiveRecording] = useState<LiveRecordingSession | null>(null);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");

  const timelineEngine = useMemo(() => new TimelineEngine(), []);
  const modeIsCompare = comparisonMode === "compare";
  const workspaceHasVideo = Boolean(playerVideoLeft || playerVideoRight);

  const leftStore = useAnalysisStore({
    playerId: resolvedPlayerId,
    lessonId,
    videoId: LEFT_ANALYSIS_SLOT,
    persistenceAdapter: persistenceLayer.analysisAdapter,
  });

  const rightStore = useAnalysisStore({
    playerId: resolvedPlayerId,
    lessonId,
    videoId: RIGHT_ANALYSIS_SLOT,
    persistenceAdapter: persistenceLayer.analysisAdapter,
  });

  useEffect(() => {
    if (livePreviewRef.current) {
      livePreviewRef.current.srcObject = liveStream;
    }
  }, [liveStream]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      stopLiveStream(liveStream);
    };
  }, [liveStream, stopLiveStream]);

  // Restore on-device videos once per player/lesson context. Reconstructs a
  // File from the stored blob and runs it through the normal load path so the
  // mounted <video> and metadata match a fresh upload.
  const videoHydrationRef = useRef<string | null>(null);
  useEffect(() => {
    const videoStore = persistenceLayer.videoStore;
    if (!videoStore) return;

    const hydrationKey = `${resolvedPlayerId}::${lessonId ?? "default"}`;
    if (videoHydrationRef.current === hydrationKey) return;
    videoHydrationRef.current = hydrationKey;

    let cancelled = false;

    const hydrateSide = async (side: ComparisonSide) => {
      const stored = await videoStore.getVideo(
        buildVideoSlotKey(resolvedPlayerId, side, lessonId)
      );
      if (cancelled || !stored) return;

      const isLeft = side === "left";
      const playback = isLeft ? leftPlayback : rightPlayback;
      const setPlayerVideo = isLeft ? setPlayerVideoLeft : setPlayerVideoRight;
      const setMountedSource = isLeft
        ? setLeftMountedSource
        : setRightMountedSource;
      const setMetadataReady = isLeft
        ? setLeftMetadataReady
        : setRightMetadataReady;

      const restoredFile = new File(
        [stored.blob],
        stored.video.title || `video-${side}`,
        { type: stored.blob.type || "video/mp4" }
      );
      const loaded = await playback.loadVideoFile(restoredFile);
      if (cancelled) return;

      setPlayerVideo({ ...stored.video, sourceUrl: loaded.sourceUrl });
      setMountedSource(loaded.sourceUrl);
      setMetadataReady(false);
    };

    void hydrateSide("left").catch(() => {
      // Ignore; a hydration failure leaves the side empty and uploadable.
    });
    void hydrateSide("right").catch(() => {
      // Ignore; a hydration failure leaves the side empty and uploadable.
    });

    return () => {
      cancelled = true;
    };
  }, [persistenceLayer, resolvedPlayerId, lessonId, leftPlayback, rightPlayback]);

  const leftCurrentDuration = playerVideoLeft?.duration || leftPlayback.duration;
  const rightCurrentDuration = playerVideoRight?.duration || rightPlayback.duration;

  const leftFallbackMarkers = useMemo(() => {
    if (leftStore.analysis.markers.length) {
      return leftStore.analysis.markers;
    }
    return timelineEngine.getDefaultMarkers(Math.max(1, leftCurrentDuration || 0));
  }, [leftCurrentDuration, leftStore.analysis.markers, timelineEngine]);

  const rightFallbackMarkers = useMemo(() => {
    if (rightStore.analysis.markers.length) {
      return rightStore.analysis.markers;
    }
    return timelineEngine.getDefaultMarkers(Math.max(1, rightCurrentDuration || 0));
  }, [rightCurrentDuration, rightStore.analysis.markers, timelineEngine]);

  const leftTimelineState = useTimeline();
  const rightTimelineState = useTimeline();

  // Markers are owned by the analysis store; fall back to generated defaults for
  // display only when the store has none yet.
  const leftMarkers = leftStore.analysis.markers.length
    ? leftStore.analysis.markers
    : leftFallbackMarkers;
  const rightMarkers = rightStore.analysis.markers.length
    ? rightStore.analysis.markers
    : rightFallbackMarkers;

  const leftDrawing = useDrawing({
    initialObjects: leftStore.analysis.drawings,
    videoDimensions: leftOverlayDimensions,
    onChange: leftStore.setDrawings,
  });

  const rightDrawing = useDrawing({
    initialObjects: rightStore.analysis.drawings,
    videoDimensions: rightOverlayDimensions,
    onChange: rightStore.setDrawings,
  });

  const effectiveActiveSide: ComparisonSide = modeIsCompare ? activeSide : "left";
  const activePlayback =
    effectiveActiveSide === "left" ? leftPlayback : rightPlayback;
  const activeDrawing = effectiveActiveSide === "left" ? leftDrawing : rightDrawing;
  const activeTimelineState =
    effectiveActiveSide === "left" ? leftTimelineState : rightTimelineState;
  const activeTimelineHoverMarker =
    effectiveActiveSide === "left" ? leftHoverMarker : rightHoverMarker;
  const activeStoreDrawingVideo =
    effectiveActiveSide === "left" ? playerVideoLeft : playerVideoRight;
  const activeDuration =
    effectiveActiveSide === "left" ? leftCurrentDuration || 0 : rightCurrentDuration || 0;
  const activeFrame = Math.round(
    activePlayback.currentTime *
      (activeStoreDrawingVideo?.fps || activePlayback.frameRate || FRAME_RATE_DEFAULT)
  );
  const allFocusSnapshots = useMemo(() => {
    const leftSnapshots =
      leftStore.analysis.focusSnapshots.map((snapshot) => ({ ...snapshot, side: "left" as const }));
    const rightSnapshots =
      rightStore.analysis.focusSnapshots.map((snapshot) => ({ ...snapshot, side: "right" as const }));

    return [...leftSnapshots, ...rightSnapshots].sort((left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
  }, [leftStore.analysis.focusSnapshots, rightStore.analysis.focusSnapshots]);

  const focusSnapshotStats = useMemo(() => {
    const total = allFocusSnapshots.length;
    const totalBytes = allFocusSnapshots.reduce((sum, snapshot) => {
      return sum + getDataUrlBytes(snapshot.imageDataUrl);
    }, 0);
    return {
      total,
      totalBytes,
      estimatedMB: totalBytes / (1024 * 1024),
      shouldWarn: total >= SNAPSHOT_STORAGE_WARNING_LIMIT,
    };
  }, [allFocusSnapshots]);
  const canManualSave = useMemo(
    () =>
      Boolean(
        playerVideoLeft ||
          playerVideoRight ||
          hasSaveableAnalysisContent(leftStore.analysis) ||
          hasSaveableAnalysisContent(rightStore.analysis)
      ),
    [leftStore.analysis, playerVideoLeft, playerVideoRight, rightStore.analysis]
  );

  useEffect(() => {
    if (!canManualSave && saveStatus === "saved") {
      setSaveStatus("idle");
      setSaveMessage("Nothing to save yet.");
    }
  }, [canManualSave, saveStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadComparisonWorkspaceState(
        persistenceLayer.workspaceAdapter,
        workspaceContext
      );
      if (cancelled) return;
      if (loaded) {
        setComparisonMode(loaded.mode);
        setActiveSide(loaded.mode === "single" ? "left" : loaded.activeSide);
        setLinkedPlayback(loaded.linkedPlayback);
        setShowFocusWindow(loaded.focusWindowOpen);
        setFocusWindowMode(loaded.focusWindowMode);
        setFocusWindowSide(loaded.mode === "single" ? "left" : loaded.focusWindowSide);
        setFocusAreaRect(loaded.focusAreaRect);
        setCurrentSavedVideoIds(loaded.savedVideoIds || {});
      }
      // Mark hydration complete so the save effect can begin persisting without
      // first overwriting restored state with mount-time defaults.
      setWorkspaceHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [persistenceLayer.workspaceAdapter, workspaceContext]);

  const buildWorkspaceState = useCallback((): ComparisonWorkspaceState => {
    return {
      version: 1,
      mode: comparisonMode,
      activeSide,
      savedVideoIds: currentSavedVideoIds,
      linkedPlayback,
      focusWindowOpen: showFocusWindow,
      focusWindowMode,
      focusWindowSide,
      focusAreaRect,
    };
  }, [
    activeSide,
    comparisonMode,
    currentSavedVideoIds,
    focusAreaRect,
    focusWindowMode,
    focusWindowSide,
    linkedPlayback,
    showFocusWindow,
  ]);

  const saveWorkspaceState = useCallback(() => {
    return saveComparisonWorkspaceState(
      buildWorkspaceState(),
      persistenceLayer.workspaceAdapter,
      workspaceContext
    );
  }, [
    buildWorkspaceState,
    persistenceLayer.workspaceAdapter,
    workspaceContext,
  ]);

  useEffect(() => {
    if (!workspaceHydrated) return;
    void saveWorkspaceState();
  }, [saveWorkspaceState, workspaceHydrated]);

  const updateMode = (next: WorkspaceMode) => {
    setComparisonMode(next);
    if (next === "single") {
      setActiveSide("left");
    }
  };

  const setActiveSideInCompare = useCallback(
    (side: ComparisonSide) => {
      if (!modeIsCompare) {
        return;
      }
      setActiveSide(side);
    },
    [modeIsCompare]
  );

  const isDrawingKeyboardFocus = activeDrawing.selectedObjectId !== null;

  const syncMarkersWithAnalysis = useCallback(
    (side: ComparisonSide, next: TimelineMarker[]) => {
      if (side === "left") {
        leftStore.setMarkers(next);
        return;
      }
      rightStore.setMarkers(next);
    },
    [leftStore, rightStore]
  );

  const playPauseSide = useCallback(
    (side: ComparisonSide) => {
      if (side === "left") {
        if (!playerVideoLeft) return;
        leftPlayback.togglePlayPause();
        return;
      }
      if (!playerVideoRight) return;
      rightPlayback.togglePlayPause();
    },
    [leftPlayback, playerVideoLeft, playerVideoRight, rightPlayback]
  );

  const toggleSidePlayback = useCallback(() => {
    const activeVideo = effectiveActiveSide === "left" ? playerVideoLeft : playerVideoRight;

    if (!modeIsCompare) {
      playPauseSide(activeVideo ? effectiveActiveSide : "left");
      return;
    }

    if (linkedPlayback) {
      // Drive every loaded side to the same target state using explicit
      // play/pause (never per-side toggles, which can desync the lanes).
      const anyPlaying =
        (Boolean(playerVideoLeft) && leftPlayback.isPlaying) ||
        (Boolean(playerVideoRight) && rightPlayback.isPlaying);
      const shouldPlay = !anyPlaying;
      if (playerVideoLeft) {
        if (shouldPlay) leftPlayback.play();
        else leftPlayback.pause();
      }
      if (playerVideoRight) {
        if (shouldPlay) rightPlayback.play();
        else rightPlayback.pause();
      }
      return;
    }

    if (!activeVideo) {
      if (playerVideoLeft) {
        playPauseSide("left");
        return;
      }
      if (playerVideoRight) {
        playPauseSide("right");
        return;
      }
      return;
    }

    playPauseSide(effectiveActiveSide);
  }, [
    effectiveActiveSide,
    linkedPlayback,
    modeIsCompare,
    playerVideoLeft,
    playerVideoRight,
    playPauseSide,
    leftPlayback,
    rightPlayback,
  ]);

  const stepActiveSide = useCallback(
    (direction: -1 | 1, options: { shift?: boolean; heldFrames?: number } = {}) => {
      const targetPlayback = effectiveActiveSide === "left" ? leftPlayback : rightPlayback;
      targetPlayback.stepFrame(direction, {
        shift: !!options.shift,
        heldFrames: options.heldFrames,
      });
    },
    [effectiveActiveSide, leftPlayback, rightPlayback]
  );

  const syncPlayheads = useCallback(() => {
    if (!modeIsCompare || !playerVideoLeft || !playerVideoRight) {
      return;
    }

    const sourceSide = effectiveActiveSide;
    const sourcePlayback = sourceSide === "left" ? leftPlayback : rightPlayback;
    const targetPlayback = sourceSide === "left" ? rightPlayback : leftPlayback;
    const sourceFrame = Math.round(
      sourcePlayback.currentTime * (sourcePlayback.frameRate || FRAME_RATE_DEFAULT)
    );
    const targetFps = targetPlayback.frameRate || FRAME_RATE_DEFAULT;
    targetPlayback.seekTo(sourceFrame / targetFps);
  }, [effectiveActiveSide, leftPlayback, modeIsCompare, playerVideoLeft, playerVideoRight, rightPlayback]);

  const updateActiveDrawingTool = (tool: DrawingTool) => {
    leftDrawing.setTool(tool);
    rightDrawing.setTool(tool);
  };

  const onSourceLoad = useCallback(
    (side: ComparisonSide) => {
      const isLeft = side === "left";
      const videoRef = isLeft ? leftVideoRef.current : rightVideoRef.current;
      const analysisStore = isLeft ? leftStore : rightStore;
      const setMetadataReady = isLeft ? setLeftMetadataReady : setRightMetadataReady;
      const setMountedSource = isLeft ? setLeftMountedSource : setRightMountedSource;
      const setPlaybackSource = isLeft ? leftPlayback.sourceUrl : rightPlayback.sourceUrl;
      const playerVideo = isLeft ? playerVideoLeft : playerVideoRight;

      if (!videoRef || !playerVideo) {
        return;
      }

      const safeDuration = videoRef.duration || playerVideo.duration || 1;
      setMountedSource(setPlaybackSource);
      setMetadataReady(true);

      if (!analysisStore.analysis.markers.length) {
        const defaults = timelineEngine.getDefaultMarkers(safeDuration);
        analysisStore.setMarkers(defaults);
      }
    },
    [
      leftPlayback,
      rightPlayback,
      leftStore,
      rightStore,
      playerVideoLeft,
      playerVideoRight,
      timelineEngine,
    ]
  );

  const loadClipFileForSide = useCallback(
    async (side: ComparisonSide, file: File) => {
      const isLeft = side === "left";
      const playback = isLeft ? leftPlayback : rightPlayback;
      const analysisStore = isLeft ? leftStore : rightStore;
      const setPlayerVideo = isLeft ? setPlayerVideoLeft : setPlayerVideoRight;
      const setMountedSource = isLeft ? setLeftMountedSource : setRightMountedSource;
      const setMetadataReady = isLeft ? setLeftMetadataReady : setRightMetadataReady;

      const loaded = await playback.loadVideoFile(file);
      const nextVideo: PlayerVideo = {
        id: createId(`video-${side}`),
        playerId: resolvedPlayerId,
        lessonId,
        sourceUrl: loaded.sourceUrl,
        title: file.name,
        createdAt: new Date().toISOString(),
        duration: loaded.duration,
        fps: loaded.fps,
        width: loaded.width,
        height: loaded.height,
      };
      const safeDuration = loaded.duration || 1;
      const defaults = timelineEngine.getDefaultMarkers(safeDuration);

      setPlayerVideo(nextVideo);
      setMountedSource(nextVideo.sourceUrl);
      setMetadataReady(false);
      analysisStore.updateAnalysis({
        videoId: nextVideo.id,
        videoMeta: {
          title: nextVideo.title,
          duration: nextVideo.duration,
          fps: nextVideo.fps,
          width: nextVideo.width,
          height: nextVideo.height,
        },
        markers: defaults,
        drawings: [],
      });
      setCurrentSavedVideoIds((current) => ({ ...current, [side]: undefined }));
      setActiveSideInCompare(side);

      // Persist the raw video bytes on-device so the upload survives a reload.
      // Fire-and-forget: a storage failure must never break the live upload.
      const videoStore = persistenceLayer.videoStore;
      if (videoStore) {
        void requestPersistentStorage();
        void videoStore
          .putVideo(
            buildVideoSlotKey(resolvedPlayerId, side, lessonId),
            nextVideo,
            file
          )
          .catch(() => {
            // Ignore; the in-memory session still works without persistence.
          });
      }
    },
    [
      leftPlayback,
      rightPlayback,
      leftStore,
      rightStore,
      timelineEngine,
      lessonId,
      resolvedPlayerId,
      setActiveSideInCompare,
      persistenceLayer,
    ]
  );

  const handleUpload = useCallback(
    async (side: ComparisonSide, event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = "";
      if (!file) {
        return;
      }
      await loadClipFileForSide(side, file);
      setIntakeError("");
      setSaveStatus("idle");
      setSaveMessage("Clip ready to save.");
    },
    [loadClipFileForSide]
  );

  const handleDropUpload = useCallback(
    async (side: ComparisonSide, event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragTargetSide(null);

      const file =
        Array.from(event.dataTransfer.files).find((entry) =>
          entry.type.startsWith("video/")
        ) ?? null;

      if (!file) {
        setIntakeError("Drop a video file to upload.");
        return;
      }

      try {
        await loadClipFileForSide(side, file);
        setIntakeError("");
        setSaveStatus("idle");
        setSaveMessage("Clip ready to save.");
      } catch (error) {
        setIntakeError("Upload failed. Try a different video file.");
        setSaveStatus("error");
        setSaveMessage("Upload failed. Try a different video file.");
        // eslint-disable-next-line no-console
        console.error("Dropped video upload failed", error);
      }
    },
    [loadClipFileForSide]
  );

  const handleDropZoneDrag = useCallback(
    (side: ComparisonSide, event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDragTargetSide(side);
    },
    []
  );

  const restoreSavedVideo = useCallback(
    async (targetSavedVideoId: string) => {
      if (!savedVideoStore) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_LOAD_FAILED",
          "Saved video library is unavailable in this browser."
        );
      }

      let item = await savedVideoStore.getItem(targetSavedVideoId);
      if (!item) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_METADATA_MISSING",
          "Saved video metadata could not be found."
        );
      }

      let blob = await savedVideoStore.getBlob(targetSavedVideoId);
      if (!blob && (item.cloud?.status === "ready" || item.cloud?.status === "imported")) {
        setSaveStatus("downloading");
        setSaveMessage("Downloading from Clarity Cloud...");
        item = await importSavedVideoFromClarityCloud(targetSavedVideoId, savedVideoStore);
        onSavedVideoLibraryChange?.();
        blob = await savedVideoStore.getBlob(item.savedVideoId);
      }
      if (!blob) {
        setSaveStatus("error");
        setSaveMessage("Device copy unavailable. Saved card was kept for recovery.");
        return;
      }

      const side = item.sourceSide || "left";
      const isLeft = side === "left";
      const playback = isLeft ? leftPlayback : rightPlayback;
      const analysisStore = isLeft ? leftStore : rightStore;
      const setPlayerVideo = isLeft ? setPlayerVideoLeft : setPlayerVideoRight;
      const setMountedSource = isLeft ? setLeftMountedSource : setRightMountedSource;
      const setMetadataReady = isLeft ? setLeftMetadataReady : setRightMetadataReady;
      const file = new File(
        [blob],
        item.source.originalFileName || item.title || "saved-video",
        { type: item.source.mimeType || blob.type || "video/mp4" }
      );
      const loaded = await playback.loadVideoFile(file);
      const restoredVideo: PlayerVideo = {
        id: item.savedVideoId,
        playerId: item.playerId,
        lessonId: item.lessonId,
        sourceUrl: loaded.sourceUrl,
        title: item.title || item.source.originalFileName,
        createdAt: item.capturedAt || item.createdAt,
        duration: item.source.duration || loaded.duration,
        fps: item.analysisSnapshot.videoMeta?.fps || loaded.fps,
        width: item.source.width || loaded.width,
        height: item.source.height || loaded.height,
      };

      setPlayerVideo(restoredVideo);
      setMountedSource(restoredVideo.sourceUrl);
      setMetadataReady(false);
      analysisStore.replaceAnalysis({
        ...item.analysisSnapshot,
        playerId: item.playerId,
        lessonId: item.lessonId,
        videoId: item.savedVideoId,
        videoMeta: {
          ...item.analysisSnapshot.videoMeta,
          title: item.title,
          duration: restoredVideo.duration,
          fps: restoredVideo.fps,
          width: restoredVideo.width,
          height: restoredVideo.height,
        },
      });
      setComparisonMode(item.workspaceSnapshot.mode);
      setActiveSide(item.workspaceSnapshot.mode === "single" ? "left" : item.workspaceSnapshot.activeSide);
      setLinkedPlayback(item.workspaceSnapshot.linkedPlayback);
      setShowFocusWindow(item.workspaceSnapshot.focusWindowOpen);
      setFocusWindowMode(item.workspaceSnapshot.focusWindowMode);
      setFocusWindowSide(item.workspaceSnapshot.mode === "single" ? "left" : item.workspaceSnapshot.focusWindowSide);
      setFocusAreaRect(item.workspaceSnapshot.focusAreaRect);
      setCurrentSavedVideoIds({
        ...item.workspaceSnapshot.savedVideoIds,
        [side]: item.savedVideoId,
      });
      setActiveSideInCompare(side);

      persistenceLayer.videoStore
        ?.putVideo(buildVideoSlotKey(item.playerId, side, item.lessonId), restoredVideo, blob)
        .catch(() => {
          // Saved library stays intact even if the recovery copy cannot be rebuilt.
        });

      setSaveStatus("idle");
      setSaveMessage("Saved video loaded.");
    },
    [
      leftPlayback,
      leftStore,
      persistenceLayer.videoStore,
      rightPlayback,
      rightStore,
      savedVideoStore,
      setActiveSideInCompare,
      onSavedVideoLibraryChange,
    ]
  );

  const openedSavedVideoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!savedVideoId || openedSavedVideoRef.current === savedVideoId) return;
    openedSavedVideoRef.current = savedVideoId;
    void restoreSavedVideo(savedVideoId).catch((error) => {
      setSaveStatus("error");
      setSaveMessage(
        error instanceof SavedVideoLibraryError
          ? error.message
          : "Saved video could not be loaded."
      );
      // eslint-disable-next-line no-console
      console.error("Saved video load failed", error);
    });
  }, [restoreSavedVideo, savedVideoId]);

  const openLiveRecording = useCallback(
    async (side: ComparisonSide, cameraId = selectedCameraId) => {
      if (
        liveRecording?.status === "recording" ||
        liveRecording?.status === "processing"
      ) {
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setLiveRecording({
          side,
          status: "error",
          error: "Live recording is not available in this browser.",
          startedAt: null,
        });
        return;
      }

      try {
        stopLiveStream(liveStream);
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        };
        if (cameraId) {
          videoConstraints.deviceId = { exact: cameraId };
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((device) => device.kind === "videoinput");
        const activeDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId || cameraId;

        setCameraDevices(cameras);
        setSelectedCameraId(activeDeviceId || cameraId || "");
        setLiveStream(stream);
        setLiveRecording({
          side,
          status: "ready",
          error: null,
          startedAt: null,
        });
        setActiveSideInCompare(side);
      } catch (error) {
        setLiveStream(null);
        setLiveRecording({
          side,
          status: "error",
          error: error instanceof Error ? error.message : "Could not open camera.",
          startedAt: null,
        });
      }
    },
    [
      liveRecording?.status,
      liveStream,
      selectedCameraId,
      setActiveSideInCompare,
      stopLiveStream,
    ]
  );

  const closeLiveRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      return;
    }
    stopLiveStream(liveStream);
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];
    setLiveStream(null);
    setLiveRecording(null);
  }, [liveStream, stopLiveStream]);

  const startLiveRecording = useCallback(() => {
    if (!liveRecording || !liveStream) {
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setLiveRecording((current) =>
        current
          ? {
              ...current,
              status: "error",
              error: "Recording is not available in this browser.",
            }
          : current
      );
      return;
    }

    try {
      const mimeType = getPreferredRecordingMimeType();
      const recorder = new MediaRecorder(
        liveStream,
        mimeType ? { mimeType } : undefined
      );
      const recordingSide = liveRecording.side;
      recordingChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setLiveRecording((current) =>
          current
            ? {
                ...current,
                status: "error",
                error: "Recording failed.",
                startedAt: null,
              }
            : current
        );
      };
      recorder.onstop = () => {
        void (async () => {
          const blobType =
            mimeType || recordingChunksRef.current.find((chunk) => chunk.type)?.type || "video/webm";
          const blob = new Blob(recordingChunksRef.current, { type: blobType });
          recordingChunksRef.current = [];
          mediaRecorderRef.current = null;

          if (!blob.size) {
            setLiveRecording((current) =>
              current
                ? {
                    ...current,
                    status: "error",
                    error: "Recording did not capture any video.",
                    startedAt: null,
                  }
                : current
            );
            return;
          }

          const file = new File(
            [blob],
            getRecordingFileName(recordingSide, blob.type || blobType),
            { type: blob.type || blobType }
          );
          await loadClipFileForSide(recordingSide, file);
          setSaveStatus("idle");
          setSaveMessage("Recording ready to save.");
          setLiveRecording((current) =>
            current && current.side === recordingSide
              ? {
                  ...current,
                  status: "ready",
                  error: null,
                  startedAt: null,
                }
              : current
          );
        })();
      };

      recorder.start(250);
      setLiveRecording((current) =>
        current
          ? {
              ...current,
              status: "recording",
              error: null,
              startedAt: Date.now(),
            }
          : current
      );
    } catch (error) {
      setLiveRecording((current) =>
        current
          ? {
              ...current,
              status: "error",
              error: error instanceof Error ? error.message : "Could not start recording.",
              startedAt: null,
            }
          : current
      );
    }
  }, [liveRecording, liveStream, loadClipFileForSide]);

  const stopLiveRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return;
    }
    setLiveRecording((current) =>
      current
        ? {
            ...current,
            status: "processing",
          }
        : current
    );
    recorder.stop();
  }, []);

  const handleCameraChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextCameraId = event.target.value;
      setSelectedCameraId(nextCameraId);
      if (
        liveRecording &&
        liveRecording.status !== "recording" &&
        liveRecording.status !== "processing"
      ) {
        void openLiveRecording(liveRecording.side, nextCameraId);
      }
    },
    [liveRecording, openLiveRecording]
  );

  const handleCanvasPointerDown = useCallback(
    (side: ComparisonSide, point: { x: number; y: number }) => {
      const hasVideo = side === "left" ? !!playerVideoLeft : !!playerVideoRight;
      if (!hasVideo) {
        return;
      }
      if (focusSelectionMode === "area") {
        const isLeft = side === "left";
        const start = normalizePoint(point, isLeft ? leftOverlayDimensions : rightOverlayDimensions);
        setActiveSideInCompare(side);
        setFocusSelectionSide(side);
        setFocusSelectionStart(start);
        setFocusSelectionDraft({
          x: start.x,
          y: start.y,
          width: 0,
          height: 0,
        });
        return;
      }
      setActiveSideInCompare(side);
      if (side === "left") {
        leftDrawing.pointerDown(point);
        return;
      }
      rightDrawing.pointerDown(point);
    },
    [
      focusSelectionMode,
      leftDrawing,
      leftOverlayDimensions,
      playerVideoLeft,
      rightDrawing,
      rightOverlayDimensions,
      setActiveSideInCompare,
      playerVideoRight,
    ]
  );

  const handleCanvasPointerMove = useCallback(
    (side: ComparisonSide, point: { x: number; y: number }) => {
      if (!focusSelectionMode || !focusSelectionStart || focusSelectionSide !== side) {
        if (side === "left") {
          leftDrawing.pointerMove(point);
          return;
        }
        rightDrawing.pointerMove(point);
        return;
      }

      const isLeft = side === "left";
      const current = normalizePoint(point, isLeft ? leftOverlayDimensions : rightOverlayDimensions);
      setFocusSelectionDraft(buildRectFromDrag(focusSelectionStart, current));
      return;
    },
    [
      focusSelectionMode,
      focusSelectionSide,
      focusSelectionStart,
      leftDrawing,
      leftOverlayDimensions,
      rightDrawing,
      rightOverlayDimensions,
    ]
  );

  const handleCanvasPointerUp = useCallback(
    (side: ComparisonSide, point: { x: number; y: number }) => {
      if (focusSelectionMode === "area" && focusSelectionSide === side && focusSelectionDraft) {
        const canCreate = focusSelectionDraft.width > MIN_ACTIVE_SELECTION_SIZE && focusSelectionDraft.height > MIN_ACTIVE_SELECTION_SIZE;
        if (canCreate) {
          setFocusAreaRect(focusSelectionDraft);
          setFocusWindowMode("area");
          setFocusWindowSide(side);
          setShowFocusWindow(true);
          setFocusPaletteOpen(false);
        }
        setFocusSelectionMode(null);
        setFocusSelectionDraft(null);
        setFocusSelectionStart(null);
        return;
      }
      if (side === "left") {
        leftDrawing.pointerUp(point);
        return;
      }
      rightDrawing.pointerUp(point);
    },
    [
      focusSelectionDraft,
      focusSelectionMode,
      focusSelectionSide,
      leftDrawing,
      rightDrawing,
      setFocusWindowMode,
      setFocusWindowSide,
    ]
  );

  const setMarkerHoverForSide = (side: ComparisonSide, marker: TimelineMarker | null) => {
    if (side === "left") {
      setLeftHoverMarker(marker);
      return;
    }
    setRightHoverMarker(marker);
  };

  const onTimelineSeek = (side: ComparisonSide, time: number) => {
    if (side === "left") {
      leftPlayback.seekTo(time);
      return;
    }
    rightPlayback.seekTo(time);
  };

  const onMarkerJump = (side: ComparisonSide, marker: TimelineMarker) => {
    if (side === "left") {
      leftPlayback.seekTo(marker.time);
      return;
    }
    rightPlayback.seekTo(marker.time);
  };

  const onMarkerMove = (side: ComparisonSide, marker: TimelineMarker, time: number) => {
    const current = side === "left" ? leftMarkers : rightMarkers;
    const next = current.map((entry) =>
      entry.id === marker.id ? { ...entry, time: Math.max(0, time) } : entry
    );
    syncMarkersWithAnalysis(side, next);
  };

  const openUpload = (side: ComparisonSide) => {
    clearFocusSelection();
    if (side === "left") {
      leftUploadInputRef.current?.click();
      return;
    }
    rightUploadInputRef.current?.click();
  };

  const clearCurrentSide = useCallback(
    (side: ComparisonSide) => {
      const isLeft = side === "left";
      const playback = isLeft ? leftPlayback : rightPlayback;
      const setPlayerVideo = isLeft ? setPlayerVideoLeft : setPlayerVideoRight;
      const setMountedSource = isLeft ? setLeftMountedSource : setRightMountedSource;
      const setMetadataReady = isLeft ? setLeftMetadataReady : setRightMetadataReady;
      const analysisStore = isLeft ? leftStore : rightStore;

      if (isLeft ? !playerVideoLeft : !playerVideoRight) {
        return;
      }

      playback.clearSource();
      if (showFocusWindow && focusWindowSide === side) {
        setShowFocusWindow(false);
        setFocusAreaRect(null);
      }
      analysisStore.updateAnalysis({
        videoMeta: undefined,
        markers: [],
        drawings: [],
      });
      setPlayerVideo(null);
      setMountedSource(null);
      setMetadataReady(false);
      setCurrentSavedVideoIds((current) => ({ ...current, [side]: undefined }));

      // Drop the on-device copy for this slot so it is not re-hydrated later.
      persistenceLayer.videoStore
        ?.removeVideo(buildVideoSlotKey(resolvedPlayerId, side, lessonId))
        .catch(() => {
          // Ignore; removal is best-effort.
        });
    },
    [
      leftPlayback,
      rightPlayback,
      leftStore,
      rightStore,
      playerVideoLeft,
      playerVideoRight,
      focusWindowSide,
      showFocusWindow,
      persistenceLayer,
      resolvedPlayerId,
      lessonId,
    ]
  );

  const clearFocusSelection = useCallback(() => {
    setFocusSelectionMode(null);
    setFocusSelectionSide("left");
    setFocusSelectionStart(null);
    setFocusSelectionDraft(null);
  }, []);

  const buildNavigationContext = useCallback(
    (reason: VideoWorkspaceNavigationContext["reason"]): VideoWorkspaceNavigationContext => ({
      playerId: playerId || undefined,
      playerName: playerName || (playerId ? resolvedPlayerName : undefined),
      lessonId,
      savedVideoId: savedVideoId || currentSavedVideoIds.left || currentSavedVideoIds.right,
      hasPlayerContext: Boolean(playerId),
      reason,
    }),
    [
      currentSavedVideoIds.left,
      currentSavedVideoIds.right,
      lessonId,
      playerId,
      playerName,
      resolvedPlayerName,
      savedVideoId,
    ]
  );

  // Back priority: cancel active draw/edit -> cancel focus selection -> close
  // focus palette -> close focus window -> compare back to single -> explicit
  // app navigation callback.
  const handleBackAction = useCallback(() => {
    if (activeDrawing.isDrawingActionActive) {
      activeDrawing.cancel();
      return;
    }
    if (focusSelectionMode) {
      clearFocusSelection();
      return;
    }
    if (focusPaletteOpen) {
      setFocusPaletteOpen(false);
      return;
    }
    if (showFocusWindow) {
      setShowFocusWindow(false);
      return;
    }
    if (comparisonMode === "compare") {
      updateMode("single");
      return;
    }
    if (onNavigateBack) {
      onNavigateBack(buildNavigationContext("toolbar-back"));
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("video_analysis_navigation_fallback_missing", {
      hasPlayerContext: Boolean(playerId),
      reason: "toolbar-back",
    });
  }, [
    activeDrawing,
    buildNavigationContext,
    comparisonMode,
    focusPaletteOpen,
    showFocusWindow,
    focusSelectionMode,
    clearFocusSelection,
    onNavigateBack,
    playerId,
    updateMode,
  ]);

  const canGoBack =
    activeDrawing.isDrawingActionActive ||
    Boolean(focusSelectionMode) ||
    focusPaletteOpen ||
    showFocusWindow ||
    comparisonMode === "compare" ||
    Boolean(onNavigateBack);
  const clearDrawingLabel = activeDrawing.selectedObjectId
    ? "Clear selected"
    : "Clear drawings on this side";
  const clearDrawingTooltip = clearDrawingLabel;
  const canClearDrawings = activeDrawing.objects.length > 0;

  const clearActiveDrawing = useCallback(() => {
    if (activeDrawing.selectedObjectId) {
      activeDrawing.deleteSelected();
      return;
    }
    if (!activeDrawing.objects.length) {
      return;
    }
    const message = `Clear ${activeDrawing.objects.length} drawings on this side? This can be undone.`;
    if (!window.confirm(message)) {
      return;
    }
    activeDrawing.clearAll();
  }, [activeDrawing]);

  const resetFocusWindowHover = useCallback(
    (side: ComparisonSide, isHovering: boolean) => {
      if (isHovering) {
        setFocusWindowHoverSide(side);
        return;
      }
      setFocusWindowHoverSide((current) => (current === side ? null : current));
    },
    []
  );

  const removeFocusSnapshot = useCallback(
    (side: ComparisonSide, snapshotId: string) => {
      setFocusArtifactExpandedId((current) => (current === snapshotId ? null : current));
      if (side === "left") {
        const nextSnapshots = (leftStore.analysis.focusSnapshots || []).filter(
          (snapshot) => snapshot.id !== snapshotId
        );
        leftStore.updateAnalysis({ focusSnapshots: nextSnapshots });
        return;
      }
      const nextSnapshots = (rightStore.analysis.focusSnapshots || []).filter(
        (snapshot) => snapshot.id !== snapshotId
      );
      rightStore.updateAnalysis({ focusSnapshots: nextSnapshots });
    },
    [leftStore, rightStore]
  );

  const renameFocusSnapshot = useCallback(
    (side: ComparisonSide, snapshotId: string) => {
      const activeStore = side === "left" ? leftStore : rightStore;
      const target = (activeStore.analysis.focusSnapshots || []).find(
        (snapshot) => snapshot.id === snapshotId
      );
      if (!target) {
        return;
      }
      const nextTitle = window.prompt("Rename snapshot", target.title);
      if (!nextTitle || !nextTitle.trim()) {
        return;
      }
      const nextSnapshots = (activeStore.analysis.focusSnapshots || []).map((snapshot) =>
        snapshot.id === snapshotId ? { ...snapshot, title: nextTitle.trim() } : snapshot
      );
      activeStore.updateAnalysis({ focusSnapshots: nextSnapshots });
    },
    [leftStore, rightStore]
  );

  const clearAllFocusSnapshots = useCallback(() => {
    if (!focusSnapshotStats.total) {
      return;
    }
    const message = `Clear all ${focusSnapshotStats.total} Focus snapshots? This cannot be undone.`;
    if (!window.confirm(message)) {
      return;
    }
    leftStore.updateAnalysis({ focusSnapshots: [] });
    rightStore.updateAnalysis({ focusSnapshots: [] });
    setFocusArtifactExpandedId(null);
  }, [focusSnapshotStats.total, leftStore, rightStore]);

  const downloadFocusSnapshot = useCallback((snapshot: FocusSnapshot) => {
    const link = document.createElement("a");
    link.href = snapshot.imageDataUrl;
    link.download = toDownloadFileName(snapshot);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  const handleFocusWindowScreenshot = useCallback(
    async (previewImageDataUrl: string): Promise<{ ok: boolean; error?: string }> => {
      if (!focusWindowSide || !focusWindowMode || focusWindowMode !== "area" || !focusAreaRect) {
        return { ok: false, error: "No valid focus crop selected." };
      }
      const isLeft = focusWindowSide === "left";
      const activeStore = isLeft ? leftStore : rightStore;
      const activePlayback = isLeft ? leftPlayback : rightPlayback;
      const sourceVideo = isLeft ? playerVideoLeft : playerVideoRight;
      const sourceVideoElement = isLeft ? leftVideoRef.current : rightVideoRef.current;

      if (!sourceVideo || !sourceVideoElement) {
        return { ok: false, error: "Source video is not available." };
      }

      let imageDataUrl = "";
      let sourceImageMeta: FocusSnapshot["sourceImageMeta"] | undefined;
      const { width: sourceWidth, height: sourceHeight } = getSafeSourceDimensions(
        sourceVideo,
        sourceVideoElement,
        activePlayback.dimensions
      );
      const sourceCrop = buildSourceCropRect(focusAreaRect, sourceWidth, sourceHeight);

      try {
        if (
          sourceVideoElement.readyState < 2 ||
          !sourceVideoElement.videoWidth ||
          !sourceVideoElement.videoHeight
        ) {
          await new Promise<void>((resolve) => {
            if (sourceVideoElement.readyState >= 2) {
              resolve();
              return;
            }
            const timeoutId = window.setTimeout(() => {
              sourceVideoElement.removeEventListener("canplay", onCanPlay);
              sourceVideoElement.removeEventListener("error", onError);
              resolve();
            }, 500);
            const onCanPlay = () => {
              sourceVideoElement.removeEventListener("canplay", onCanPlay);
              sourceVideoElement.removeEventListener("error", onError);
              clearTimeout(timeoutId);
              resolve();
            };
            const onError = () => {
              sourceVideoElement.removeEventListener("canplay", onCanPlay);
              sourceVideoElement.removeEventListener("error", onError);
              clearTimeout(timeoutId);
              resolve();
            };
            sourceVideoElement.addEventListener("canplay", onCanPlay, { once: true });
            sourceVideoElement.addEventListener("error", onError, { once: true });
          });
        }

        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = sourceCrop.sourceCropRect.width;
        sourceCanvas.height = sourceCrop.sourceCropRect.height;
        const context = sourceCanvas.getContext("2d");
        if (!context) {
          throw new Error("Could not create a source canvas.");
        }
        context.drawImage(
          sourceVideoElement,
          sourceCrop.sourceCropRect.x,
          sourceCrop.sourceCropRect.y,
          sourceCrop.sourceCropRect.width,
          sourceCrop.sourceCropRect.height,
          0,
          0,
          sourceCrop.sourceCropRect.width,
          sourceCrop.sourceCropRect.height
        );
        imageDataUrl = sourceCanvas.toDataURL("image/png");
        sourceImageMeta = createSourceImageMeta(
          sourceCrop.sourceWidth,
          sourceCrop.sourceHeight,
          sourceCrop.sourceCropRect,
          true
        );
      } catch {
        // Fall through to preview capture.
      }

      if (!isDataUrl(imageDataUrl) && isDataUrl(previewImageDataUrl)) {
        imageDataUrl = previewImageDataUrl;
        sourceImageMeta = createSourceImageMeta(
          sourceCrop.sourceWidth,
          sourceCrop.sourceHeight,
          sourceCrop.sourceCropRect,
          false
        );
      }

      if (!isDataUrl(imageDataUrl)) {
        return { ok: false, error: "Crop image data is not available." };
      }

      const safeTime = Number.isFinite(activePlayback.currentTime)
        ? activePlayback.currentTime
        : 0;
      const safeFps = sourceVideo.fps || activePlayback.frameRate || FRAME_RATE_DEFAULT;
      const safeFrame = Math.max(0, Math.round(safeTime * safeFps));

      const snapshot: FocusSnapshot = {
        id: createId(`focus-${focusWindowSide}`),
        playerId: resolvedPlayerId,
        analysisId: activeStore.analysis.id,
        title: "Focus snapshot",
        side: focusWindowSide,
        sourceVideoId: sourceVideo.id,
        sourceVideoTitle: sourceVideo.title,
        sourceVideoMeta: {
          fps: sourceVideo.fps,
          duration: sourceVideo.duration,
          width: sourceVideo.width,
          height: sourceVideo.height,
        },
        sourceImageMeta,
        currentTime: safeTime,
        currentFrame: safeFrame,
        cropRect: { ...focusAreaRect },
        imageDataUrl,
        createdAt: new Date().toISOString(),
      };

      activeStore.updateAnalysis({
        focusSnapshots: [...(activeStore.analysis.focusSnapshots || []), snapshot],
      });

      return { ok: true };
    },
    [
      focusAreaRect,
      focusWindowMode,
      focusWindowSide,
      leftPlayback,
      leftStore,
      playerVideoLeft,
      playerVideoRight,
      rightPlayback,
      rightStore,
      resolvedPlayerId,
    ]
  );

  const reselectAreaFocus = useCallback(() => {
    clearFocusSelection();
    setFocusSelectionSide(focusWindowSide);
    setFocusSelectionMode("area");
    setShowFocusWindow(false);
    setFocusPaletteOpen(false);
    setActiveSideInCompare(focusWindowSide);
  }, [clearFocusSelection, focusWindowSide, setActiveSideInCompare]);

  useEffect(() => {
    if (!modeIsCompare) {
      clearFocusSelection();
    }
  }, [clearFocusSelection, modeIsCompare]);

  useMarkerThumbnails({
    sourceUrl: leftMountedSource,
    duration: leftCurrentDuration || 0,
    markers: leftMarkers,
    enabled: leftMetadataReady && Boolean(playerVideoLeft),
    onMarkersUpdated: (next) => syncMarkersWithAnalysis("left", next),
  });

  useMarkerThumbnails({
    sourceUrl: rightMountedSource,
    duration: rightCurrentDuration || 0,
    markers: rightMarkers,
    enabled: rightMetadataReady && Boolean(playerVideoRight),
    onMarkersUpdated: (next) => syncMarkersWithAnalysis("right", next),
  });

  const currentDrawingObject = useMemo(
    () =>
      activeDrawing.objects.find((entry) => entry.id === activeDrawing.selectedObjectId) || null,
    [activeDrawing.objects, activeDrawing.selectedObjectId]
  );

  useKeyboardShortcuts({
    enabled: true,
    onPlayPause: toggleSidePlayback,
    onPrevFrame: (heldFrames, shift) =>
      stepActiveSide(-1, {
        shift,
        heldFrames,
      }),
    onNextFrame: (heldFrames, shift) =>
      stepActiveSide(1, {
        shift,
        heldFrames,
      }),
    onUndo: activeDrawing.undo,
    onRedo: activeDrawing.redo,
    onDelete: activeDrawing.deleteSelected,
    onNudgeSelected: (direction, axis, shift, heldFrames) => {
      activeDrawing.nudgeSelected(direction, axis, shift, heldFrames);
    },
    drawingLayerHasFocus: isDrawingKeyboardFocus,
    onCancel: handleBackAction,
  });

  const saveableSides = useMemo(() => {
    const sides: ComparisonSide[] = [];
    if (playerVideoLeft) sides.push("left");
    if (playerVideoRight) sides.push("right");
    return sides;
  }, [playerVideoLeft, playerVideoRight]);

  const captureSideThumbnail = useCallback(
    (side: ComparisonSide) => {
      const video = side === "left" ? leftVideoRef.current : rightVideoRef.current;
      if (!video || !video.videoWidth || !video.videoHeight) return undefined;

      try {
        const canvas = document.createElement("canvas");
        const maxWidth = 320;
        const ratio = Math.min(1, maxWidth / Math.max(1, video.videoWidth));
        canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
        canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
        const context = canvas.getContext("2d");
        if (!context) return undefined;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.72);
      } catch {
        return undefined;
      }
    },
    []
  );

  const createBlankAnalysis = useCallback(
    (videoId: string): VideoAnalysis => ({
      id: createId("analysis"),
      playerId: resolvedPlayerId,
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
    }),
    [lessonId, resolvedPlayerId]
  );

  const resetWorkspaceAfterDurableSave = useCallback(async () => {
    leftPlayback.clearSource();
    rightPlayback.clearSource();
    setPlayerVideoLeft(null);
    setPlayerVideoRight(null);
    setLeftMountedSource(null);
    setRightMountedSource(null);
    setLeftMetadataReady(false);
    setRightMetadataReady(false);
    setComparisonMode("single");
    setActiveSide("left");
    setLinkedPlayback(false);
    setShowFocusWindow(false);
    setFocusWindowMode("area");
    setFocusWindowSide("left");
    setFocusAreaRect(null);
    setCurrentSavedVideoIds({});
    leftStore.replaceAnalysis(createBlankAnalysis(LEFT_ANALYSIS_SLOT));
    rightStore.replaceAnalysis(createBlankAnalysis(RIGHT_ANALYSIS_SLOT));

    await Promise.allSettled([
      persistenceLayer.videoStore?.removeVideo(buildVideoSlotKey(resolvedPlayerId, "left", lessonId)),
      persistenceLayer.videoStore?.removeVideo(buildVideoSlotKey(resolvedPlayerId, "right", lessonId)),
      clearComparisonWorkspaceState(persistenceLayer.workspaceAdapter, workspaceContext),
      leftStore.saveNow(),
      rightStore.saveNow(),
    ]);
  }, [
    createBlankAnalysis,
    leftPlayback,
    leftStore,
    lessonId,
    persistenceLayer.videoStore,
    persistenceLayer.workspaceAdapter,
    resolvedPlayerId,
    rightPlayback,
    rightStore,
    workspaceContext,
  ]);

  const performDurableSave = useCallback(async (
    reason: VideoWorkspaceSaveResult["reason"],
    options: { archiveToMyLibrary?: boolean } = {}
  ) => {
    if (!canManualSave) {
      setSaveStatus("error");
      setSaveMessage("Add or record a clip before saving.");
      return null;
    }

    if (!saveableSides.length) {
      setSaveStatus("error");
      setSaveMessage("Save needs an uploaded or recorded video.");
      return null;
    }

    if (!savedVideoStore || !persistenceLayer.videoStore) {
      setSaveStatus("error");
      setSaveMessage("Device video storage is unavailable in this browser.");
      return null;
    }

    setSaveStatus("saving");
    setSaveMessage(options.archiveToMyLibrary ? "Saving permanently to My Library..." : "Saving...");
    setCloudUploadFailure(null);

    try {
      const [leftSaved, rightSaved] = await Promise.all([
        leftStore.saveNow(),
        rightStore.saveNow(),
      ]);

      if (!leftSaved || !rightSaved) {
        throw new Error("One side could not be saved.");
      }

      let nextSavedVideoIds = { ...currentSavedVideoIds };
      const savedItems: SavedVideoItem[] = [];

      for (const side of saveableSides) {
        const playerVideo = side === "left" ? playerVideoLeft : playerVideoRight;
        const analysisStore = side === "left" ? leftStore : rightStore;
        if (!playerVideo) continue;

        const transient = await persistenceLayer.videoStore.getVideo(
          buildVideoSlotKey(resolvedPlayerId, side, lessonId)
        );
        if (!transient?.blob) {
          throw new SavedVideoLibraryError(
            "TRANSIENT_VIDEO_NOT_FOUND",
            `${getSideTitle(side)} video source is missing from recovery storage.`
          );
        }

        const item = await savedVideoStore.saveItem({
          savedVideoId: nextSavedVideoIds[side],
          playerId: resolvedPlayerId,
          lessonId,
          title: playerVideo.title,
          sourceSide: side,
          sourceVideo: playerVideo,
          sourceBlob: transient.blob,
          analysisSnapshot: analysisStore.analysis as VideoAnalysis,
          workspaceSnapshot: buildWorkspaceState(),
          thumbnailDataUrl: captureSideThumbnail(side),
          archiveToMyLibrary: options.archiveToMyLibrary,
        });
        savedItems.push(item);
        nextSavedVideoIds = { ...nextSavedVideoIds, [side]: item.savedVideoId };
      }

      if (!savedItems.length) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_WRITE_FAILED",
          "No active video was available to save."
        );
      }

      setCurrentSavedVideoIds(nextSavedVideoIds);
      await saveComparisonWorkspaceState(
        { ...buildWorkspaceState(), savedVideoIds: nextSavedVideoIds },
        persistenceLayer.workspaceAdapter,
        workspaceContext
      );
      onSavedVideoLibraryChange?.();
      const managedCount = savedItems.filter((item) => item.local.managed?.status === "healthy").length;
      setSaveMessage(
        options.archiveToMyLibrary && managedCount === savedItems.length
          ? savedItems.length === 1
            ? "Saved permanently to My Library."
            : `Saved ${savedItems.length} videos permanently to My Library.`
          : options.archiveToMyLibrary
            ? "Saved safely on this device. Reconnect My Library when available."
          : savedItems.length === 1
            ? "Saved safely on this device. Preparing Clarity Cloud."
            : `Saved ${savedItems.length} videos safely on this device. Preparing Clarity Cloud.`
      );
      setSaveStatus("saved");
      return {
        ...buildNavigationContext(reason),
        savedVideoId: savedItems[0]?.savedVideoId || buildNavigationContext(reason).savedVideoId,
        savedItems,
        reason,
      } satisfies VideoWorkspaceSaveResult;
    } catch (error) {
      setSaveStatus("error");
      const message =
        error instanceof SavedVideoLibraryError
          ? error.message
          : "Device save failed. Workspace was kept intact.";
      setSaveMessage(message);
      // eslint-disable-next-line no-console
      console.error("Manual video analysis save failed", error);
      return null;
    }
  }, [
    buildWorkspaceState,
    buildNavigationContext,
    canManualSave,
    captureSideThumbnail,
    currentSavedVideoIds,
    leftStore,
    lessonId,
    onSavedVideoLibraryChange,
    persistenceLayer.videoStore,
    persistenceLayer.workspaceAdapter,
    playerVideoLeft,
    playerVideoRight,
    resolvedPlayerId,
    rightStore,
    saveableSides,
    savedVideoStore,
    workspaceContext,
  ]);

  const completeSuccessfulSave = useCallback(
    async (result: VideoWorkspaceSaveResult, message: string) => {
      setSaveStatus("saved");
      setSaveMessage(message);
      await resetWorkspaceAfterDurableSave();
      await briefSuccessDelay();
      await onLocalSaveComplete?.(result);
    },
    [onLocalSaveComplete, resetWorkspaceAfterDurableSave]
  );

  const handleManualSave = useCallback(async () => {
    const result = await performDurableSave("save");
    if (!result) return;
    await completeSuccessfulSave(result, "Saved safely. Returning to Player Profile.");
  }, [completeSuccessfulSave, performDurableSave]);

  const handleMyLibrarySave = useCallback(async () => {
    const result = await performDurableSave("my-library-save", { archiveToMyLibrary: true });
    if (!result) return;
    await completeSuccessfulSave(result, "Saved permanently to My Library.");
  }, [completeSuccessfulSave, performDurableSave]);

  const handleSaveAndSend = useCallback(async () => {
    const result = await performDurableSave("save");
    if (!result) return;

    if (!onSaveAndSend) {
      setSaveStatus("error");
      setSaveMessage("Transfer service unavailable.");
      setCloudUploadFailure(buildCloudUploadFailureFeedback(
        Object.assign(new Error("Transfer service unavailable."), {
          code: "CLARITY_CLOUD_PROVIDER_FAILED",
        })
      ));
      return;
    }

    setSaveStatus("sending");
    setSaveMessage("Preparing Clarity Cloud transfer...");
    setCloudUploadFailure(null);
    try {
      await onSaveAndSend(result);
      setCloudUploadFailure(null);
      await completeSuccessfulSave(result, "Uploading 0% in Player Profile.");
    } catch (error) {
      setSaveStatus("error");
      const cloudFailure = buildCloudUploadFailureFeedback(error);
      const safeMessage =
        cloudFailure.stage === "Uploading"
          ? "Cloud upload paused. Your local video is safe."
          : cloudFailure.title;
      setCloudUploadFailure(cloudFailure);
      setSaveMessage(safeMessage);
      onSavedVideoLibraryChange?.();
      // eslint-disable-next-line no-console
      console.warn("video_analysis_cloud_transfer_start_failed", {
        savedVideoIds: result.savedItems.map((item) => item.savedVideoId),
        safeErrorCode:
          typeof error === "object" && error && "code" in error
            ? String((error as { code?: unknown }).code || "CLARITY_CLOUD_TRANSFER_FAILED")
            : "CLARITY_CLOUD_TRANSFER_FAILED",
        failedStage: cloudFailure.stage,
      });
    }
  }, [
    completeSuccessfulSave,
    onSaveAndSend,
    onSavedVideoLibraryChange,
    performDurableSave,
  ]);

  const renderVideoCard = (
    side: ComparisonSide,
    metadataReady: boolean,
    overlayDimensions: { width: number; height: number },
    setOverlayDimensions: (dimensions: { width: number; height: number }) => void
  ) => {
    const isLeft = side === "left";
    const playerVideo = isLeft ? playerVideoLeft : playerVideoRight;
    const playback = isLeft ? leftPlayback : rightPlayback;
    const drawingState = isLeft ? leftDrawing : rightDrawing;
    const timelineState = isLeft ? leftTimelineState : rightTimelineState;
    const analysis = isLeft ? leftStore.analysis : rightStore.analysis;
    const markerMode = isLeft ? leftMarkers : rightMarkers;
    const hoverMarker = isLeft ? leftHoverMarker : rightHoverMarker;
    const mountedSource = isLeft ? leftMountedSource : rightMountedSource;
    const sideTitle = getSideTitle(side);
    const isActive = modeIsCompare ? activeSide === side : side === "left";
    const isFocusSourceHovered = focusWindowHoverSide === side && showFocusWindow;
    const focusSelectionDraftRect = focusSelectionDraft;
    const hasSelectionDraft =
      focusSelectionMode === "area" &&
      focusSelectionSide === side &&
      focusSelectionDraftRect !== null &&
      focusSelectionDraftRect.width > 0 &&
      focusSelectionDraftRect.height > 0;
    const draftStyle =
      hasSelectionDraft && focusSelectionDraftRect
        ? {
            left: `${focusSelectionDraftRect.x * 100}%`,
            top: `${focusSelectionDraftRect.y * 100}%`,
            width: `${focusSelectionDraftRect.width * 100}%`,
            height: `${focusSelectionDraftRect.height * 100}%`,
          }
        : null;

    const renderUploadDropZone = (primary = false) => (
      <button
        type="button"
        className={`video-upload-card ${primary ? "is-primary" : ""} ${
          dragTargetSide === side ? "is-dragging" : ""
        }`}
        onClick={(event) => {
          event.stopPropagation();
          openUpload(side);
        }}
        onDragEnter={(event) => handleDropZoneDrag(side, event)}
        onDragOver={(event) => handleDropZoneDrag(side, event)}
        onDragLeave={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragTargetSide((current) => (current === side ? null : current));
        }}
        onDrop={(event) => void handleDropUpload(side, event)}
        aria-label={`Upload ${sideTitle.toLowerCase()} clip`}
      >
        <span className="video-upload-icon" aria-hidden="true">
          <IconUpload />
        </span>
        <span className="video-upload-title">
          {primary ? "Upload a video" : `Upload ${sideTitle.toLowerCase()} clip`}
        </span>
        <span className="video-upload-copy">Drag and drop or click to choose a file</span>
        {intakeError ? (
          <span className="video-upload-error" role="alert">
            {intakeError}
          </span>
        ) : null}
      </button>
    );

    if (!playerVideo) {
      if (!workspaceHasVideo && side === "left") {
        return (
          <div className="comparison-video-panel is-intake-only">
            {renderUploadDropZone(true)}
          </div>
        );
      }

      return (
        <div
          className={`comparison-video-panel ${isActive ? "is-active" : ""}`}
          onMouseDown={() => setActiveSideInCompare(side)}
        >
          <div className="comparison-video-header">
            <div className="comparison-side-chip">
              <span>{sideTitle}</span>
              <span className="comparison-mode-label">empty</span>
            </div>
            <div className="comparison-video-actions">
              <button
                type="button"
                className="video-tool-btn"
                aria-label={`Record ${sideTitle.toLowerCase()} clip`}
                onClick={(event) => {
                  event.stopPropagation();
                  void openLiveRecording(side);
                }}
              >
                <IconRecord />
                <span className="video-tool-tip" aria-hidden="true">
                  Record {sideTitle.toLowerCase()} clip
                </span>
              </button>
              <button
                type="button"
                className="video-tool-btn"
                aria-label={`Upload ${sideTitle.toLowerCase()} clip`}
                onClick={(event) => {
                  event.stopPropagation();
                  openUpload(side);
                }}
              >
                <IconUpload />
                <span className="video-tool-tip" aria-hidden="true">
                  Upload {sideTitle.toLowerCase()} clip
                </span>
              </button>
            </div>
          </div>
          {renderUploadDropZone(!workspaceHasVideo && side === "left")}
        </div>
      );
    }

    return (
      <div
        className={`comparison-video-panel ${isActive ? "is-active" : ""} ${
          isFocusSourceHovered ? "is-focus-source" : ""
        }`}
        onMouseDown={() => setActiveSideInCompare(side)}
      >
        <div className="comparison-video-header">
          <div className="comparison-side-chip">
            <span>
              {sideTitle} • {getSideLabel(side)}
            </span>
            <span className="comparison-mode-label">
              {metadataReady ? "ready" : "loading"}
            </span>
          </div>
          <div className="comparison-video-actions">
            <button
              type="button"
              className="video-tool-btn"
              aria-label={`Record ${sideTitle.toLowerCase()} clip`}
              onClick={(event) => {
                event.stopPropagation();
                void openLiveRecording(side);
              }}
            >
              <IconRecord />
              <span className="video-tool-tip" aria-hidden="true">
                Record {sideTitle.toLowerCase()} clip
              </span>
            </button>
            <button
              type="button"
              className="video-tool-btn"
              aria-label={playback.isPlaying ? "Pause" : "Play"}
              onClick={(event) => {
                event.stopPropagation();
                playPauseSide(side);
              }}
            >
              {playback.isPlaying ? <IconPause /> : <IconPlay />}
              <span className="video-tool-tip" aria-hidden="true">
                {playback.isPlaying ? "Pause" : "Play"}
              </span>
            </button>
            <button
              type="button"
              className="upload-button"
              onClick={(event) => {
                event.stopPropagation();
                openUpload(side);
              }}
            >
              Replace {sideTitle.toLowerCase()} clip
            </button>
            <button
              type="button"
              className="upload-button video-action-button video-action-button--clear"
              onClick={(event) => {
                event.stopPropagation();
                clearCurrentSide(side);
              }}
            >
              Clear {sideTitle.toLowerCase()} clip
            </button>
          </div>
        </div>
        <div className="video-canvas-shell">
          <VideoCanvas
            sourceUrl={mountedSource}
            videoRef={isLeft ? leftVideoRef : rightVideoRef}
            onLoadMetadata={() => onSourceLoad(side)}
            objects={drawingState.objects}
            draftObject={drawingState.draftObject}
            selectedObjectId={drawingState.selectedObjectId}
            draggedObjectId={drawingState.isObjectDragging ? drawingState.draggingObjectId : null}
            onTrashDrop={(objectId) => {
              if (!drawingState.draggingObjectId || drawingState.draggingObjectId !== objectId) {
                return false;
              }
              drawingState.cancel();
              drawingState.deleteByIds([objectId]);
              return true;
            }}
            onPointerDown={(point) => {
              handleCanvasPointerDown(side, point);
            }}
            onPointerMove={(point) => {
              handleCanvasPointerMove(side, point);
            }}
            onPointerUp={(point) => {
              handleCanvasPointerUp(side, point);
            }}
            overlayDimensions={overlayDimensions}
            onDimensionsChange={setOverlayDimensions}
            onTogglePlay={() => {
              setActiveSideInCompare(side);
              playPauseSide(side);
            }}
          />
          {hasSelectionDraft ? <div className="focus-selection-overlay" style={draftStyle || undefined} /> : null}
        </div>
        <Timeline
          duration={Math.max(1, playback.duration || (isLeft ? leftCurrentDuration : rightCurrentDuration) || 0)}
          currentTime={playback.currentTime}
          zoom={timelineState.zoom}
          markers={markerMode}
          hoverMarker={hoverMarker}
          compact={modeIsCompare}
          sideLabel={`${getSideLabel(side)} ${sideTitle}`}
          onSeek={(time) => {
            setActiveSideInCompare(side);
            onTimelineSeek(side, time);
          }}
          onSetHoverMarker={(marker) => {
            setActiveSideInCompare(side);
            setMarkerHoverForSide(side, marker);
          }}
          onJumpToMarker={(marker) => {
            setActiveSideInCompare(side);
            onMarkerJump(side, marker);
          }}
          onMoveMarker={(marker, time) => {
            setActiveSideInCompare(side);
            onMarkerMove(side, marker, time);
          }}
          onScrubStateChange={(scrubbed) => {
            setActiveSideInCompare(side);
            timelineState.setScrubbing(scrubbed);
          }}
          onZoomChange={timelineState.setZoom}
        />
      </div>
    );
  };

  return (
    <div className="video-analysis-shell">
      <style>{videoAnalysisThemeCss}</style>
      <h1>{playerName ? `${playerName} Video Analysis` : "Clarity Golf Video Analysis"}</h1>
      <p className="subtitle">
        {resolvedPlayerName
          ? `${resolvedPlayerName} • ${lessonTitle || "Unlinked"} lesson context`
          : "Premium, protected, and reusable workspace foundation."}
      </p>

      <input
        ref={leftUploadInputRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={(event) => handleUpload("left", event)}
      />
      <input
        ref={rightUploadInputRef}
        type="file"
        accept="video/*"
        style={{ display: "none" }}
        onChange={(event) => handleUpload("right", event)}
      />

      {cloudUploadFailure ? (
        <section className="cloud-upload-failure-row" role="alert" aria-live="assertive">
          <div className="cloud-upload-failure-copy">
            <span className="cloud-upload-failure-stage">{cloudUploadFailure.stage}</span>
            <strong>{cloudUploadFailure.title}</strong>
            <span>{cloudUploadFailure.reason}</span>
          </div>
          <div className="cloud-upload-failure-actions">
            <button
              type="button"
              className="upload-button"
              onClick={() => void handleSaveAndSend()}
              disabled={saveStatus === "saving" || saveStatus === "sending" || saveStatus === "downloading"}
            >
              Retry
            </button>
            {cloudUploadFailure.actionRequired && onOpenCloudSettings ? (
              <button
                type="button"
                className="upload-button"
                onClick={onOpenCloudSettings}
              >
                Cloud settings
              </button>
            ) : null}
            <details className="cloud-upload-failure-diagnostics">
              <summary>Advanced diagnostic</summary>
              <dl>
                <div>
                  <dt>Safe error code</dt>
                  <dd>{cloudUploadFailure.safeErrorCode}</dd>
                </div>
                <div>
                  <dt>Failed stage</dt>
                  <dd>{cloudUploadFailure.stage}</dd>
                </div>
                {typeof cloudUploadFailure.retryable === "boolean" ? (
                  <div>
                    <dt>Retryable</dt>
                    <dd>{cloudUploadFailure.retryable ? "true" : "false"}</dd>
                  </div>
                ) : null}
                {cloudUploadFailure.httpStatus ? (
                  <div>
                    <dt>HTTP status</dt>
                    <dd>{cloudUploadFailure.httpStatus}</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          </div>
        </section>
      ) : null}

      {workspaceHasVideo ? (
        <div className="video-analysis-toolbar">
          <Toolbar
            selected={leftDrawing.selectedTool}
            onToolChange={updateActiveDrawingTool}
            showAngleTool
            onFocusOpen={() => setFocusPaletteOpen((previous) => !previous)}
            mode={comparisonMode}
            onModeChange={updateMode}
            onLinkedPlaybackToggle={() => setLinkedPlayback((previous) => !previous)}
            linkedPlayback={linkedPlayback}
            onSyncPlayheads={syncPlayheads}
            syncPlayheadsEnabled={Boolean(playerVideoLeft && playerVideoRight)}
            onBack={handleBackAction}
            canGoBack={canGoBack}
            onClearDrawings={clearActiveDrawing}
            canClearDrawings={canClearDrawings}
            clearDrawingLabel={clearDrawingLabel}
            clearDrawingTooltip={clearDrawingTooltip}
          />
          <div className="analysis-save-controls" aria-label="Video analysis save controls">
            <button
              type="button"
              className="upload-button video-save-button"
              onClick={handleManualSave}
              disabled={saveStatus === "saving" || saveStatus === "sending" || saveStatus === "downloading"}
            >
              {saveStatus === "saving" ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              className="upload-button video-save-button"
              onClick={handleMyLibrarySave}
              disabled={saveStatus === "saving" || saveStatus === "sending" || saveStatus === "downloading"}
            >
              Save permanently to My Library
            </button>
            <span className={`analysis-save-status is-${saveStatus}`} role="status">
              {saveMessage}
            </span>
          </div>
          <button
            type="button"
            className="upload-button"
            onClick={() => setShowDiagnostics((previous) => !previous)}
          >
            {showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}
          </button>
        </div>
      ) : null}

      {liveRecording ? (
        <section className="live-recording-panel" aria-label="Live recording">
          <div className="live-recording-header">
            <div>
              <h2>Live recording</h2>
              <span>{getSideTitle(liveRecording.side)} clip</span>
            </div>
            <button
              type="button"
              className="video-tool-btn is-subtle"
              onClick={closeLiveRecording}
              disabled={
                liveRecording.status === "recording" ||
                liveRecording.status === "processing"
              }
              aria-label="Close live recording"
            >
              X
            </button>
          </div>

          <div className="live-recording-body">
            <div className="live-recording-preview">
              <video ref={livePreviewRef} autoPlay muted playsInline />
            </div>
            <div className="live-recording-controls">
              <label>
                <span>Camera</span>
                <select
                  value={selectedCameraId}
                  onChange={handleCameraChange}
                  disabled={
                    liveRecording.status === "recording" ||
                    liveRecording.status === "processing"
                  }
                >
                  <option value="">Default camera</option>
                  {cameraDevices.map((device, index) => (
                    <option key={device.deviceId || index} value={device.deviceId}>
                      {device.label || `Camera ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              {liveRecording.status === "recording" ? (
                <button
                  type="button"
                  className="upload-button video-record-stop"
                  onClick={stopLiveRecording}
                >
                  Stop recording
                </button>
              ) : (
                <button
                  type="button"
                  className="upload-button"
                  onClick={startLiveRecording}
                  disabled={
                    liveRecording.status === "processing" ||
                    liveRecording.status === "error" ||
                    !liveStream
                  }
                >
                  {liveRecording.status === "processing" ? "Processing..." : "Start recording"}
                </button>
              )}
              <span className={`live-recording-status is-${liveRecording.status}`}>
                {liveRecording.status === "recording"
                  ? "Recording"
                  : liveRecording.status === "processing"
                    ? "Processing"
                    : liveRecording.error || "Camera ready"}
              </span>
            </div>
          </div>
        </section>
      ) : null}

      {!workspaceHasVideo && !liveRecording ? (
        <section className="video-intake-panel" aria-label="Add video">
          {renderVideoCard(
            "left",
            leftMetadataReady,
            leftOverlayDimensions,
            setLeftOverlayDimensions
          )}
          <div className="video-intake-actions">
            <button
              type="button"
              className="video-tool-btn"
              aria-label="Record clip"
              onClick={() => void openLiveRecording("left")}
            >
              <IconRecord />
              <span className="video-tool-tip" aria-hidden="true">
                Record clip
              </span>
            </button>
            <button
              type="button"
              className="upload-button"
              onClick={() => void openLiveRecording("left")}
            >
              Record from camera
            </button>
          </div>
        </section>
      ) : null}

      {workspaceHasVideo && (leftStore.persistenceError || rightStore.persistenceError) ? (
        <div className="focus-artifacts-warning" role="alert">
          {leftStore.persistenceError || rightStore.persistenceError} Download and
          clear older Focus snapshots to free space.
        </div>
      ) : null}

      {workspaceHasVideo ? (
        <div className={`comparison-layout ${modeIsCompare ? "is-compare" : "is-single"}`}>
          {modeIsCompare ? (
            <>
              {renderVideoCard(
                "left",
                leftMetadataReady,
                leftOverlayDimensions,
                setLeftOverlayDimensions
              )}
              {renderVideoCard(
                "right",
                rightMetadataReady,
                rightOverlayDimensions,
                setRightOverlayDimensions
              )}
            </>
          ) : (
            renderVideoCard("left", leftMetadataReady, leftOverlayDimensions, setLeftOverlayDimensions)
          )}
        </div>
      ) : null}

      {workspaceHasVideo && showFocusWindow && (
        <FocusWindow
          enabled
          mode={focusWindowMode}
          area={focusAreaRect}
          sideLabel={focusWindowSide}
          onReselect={reselectAreaFocus}
          onClose={() => {
            setShowFocusWindow(false);
          }}
          onScreenshot={handleFocusWindowScreenshot}
          sourceVideo={focusWindowSide === "left" ? leftVideoRef.current : rightVideoRef.current}
          sourceDimensions={
            focusWindowSide === "left" ? leftPlayback.dimensions : rightPlayback.dimensions
          }
          onHoverChange={(isHovering) => resetFocusWindowHover(focusWindowSide, isHovering)}
        />
      )}

      {workspaceHasVideo && focusPaletteOpen ? (
        <FocusPalette
          onSelectArea={() => {
            clearFocusSelection();
            setFocusSelectionMode("area");
            setFocusSelectionSide(modeIsCompare ? activeSide : "left");
            setShowFocusWindow(false);
            setFocusPaletteOpen(false);
          }}
          onSelectTrack={() => {
            setFocusWindowMode("track");
            setShowFocusWindow(true);
            setFocusWindowSide(activeSide);
            setFocusPaletteOpen(false);
          }}
          onClose={() => setFocusPaletteOpen(false)}
        />
      ) : null}

      {workspaceHasVideo ? (
        <div className="focus-artifacts">
          <div className="focus-artifacts-title">
            <span className="focus-artifacts-title-text">
              Focus snapshots
              <span>{focusSnapshotStats.total}</span>
            </span>
            {focusSnapshotStats.total ? (
              <button
                type="button"
                className="focus-artifacts-clear"
                onClick={clearAllFocusSnapshots}
              >
                Clear all snapshots
              </button>
            ) : null}
          </div>
          {focusSnapshotStats.shouldWarn ? (
            <div className="focus-artifacts-warning">
              You have {focusSnapshotStats.total} snapshots (~
              {focusSnapshotStats.estimatedMB.toFixed(1)} MB of local snapshot data). Consider downloading and
              clearing older shots.
            </div>
          ) : null}
          <div className="focus-artifacts-strip">
          {allFocusSnapshots.length ? (
            allFocusSnapshots.map((snapshot) => (
              <article
                className={`focus-artifact ${
                  focusArtifactExpandedId === snapshot.id ? "is-expanded" : ""
                }`}
                key={snapshot.id}
              >
                <button
                  type="button"
                  className={`focus-artifact-preview-button ${
                    focusArtifactExpandedId === snapshot.id ? "is-expanded" : ""
                  }`}
                  aria-expanded={focusArtifactExpandedId === snapshot.id}
                  onMouseEnter={() => setFocusArtifactExpandedId(snapshot.id)}
                  onMouseLeave={() =>
                    setFocusArtifactExpandedId((currentId) =>
                      currentId === snapshot.id ? null : currentId
                    )
                  }
                  onFocus={() => setFocusArtifactExpandedId(snapshot.id)}
                  onBlur={() =>
                    setFocusArtifactExpandedId((currentId) =>
                      currentId === snapshot.id ? null : currentId
                    )
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    setFocusArtifactExpandedId((currentId) =>
                      currentId === snapshot.id ? null : snapshot.id
                    );
                  }}
                  style={{
                    width: SNAPSHOT_PREVIEW_WIDTH,
                    height: SNAPSHOT_PREVIEW_HEIGHT,
                  }}
                  aria-label={`Toggle preview for ${snapshot.title}`}
                >
                  <img
                    src={snapshot.imageDataUrl}
                    className="focus-artifact-thumb"
                    alt={`Focus snapshot ${snapshot.side.toUpperCase()}`}
                  />
                </button>
                <div className="focus-artifact-body">
                  <div className="focus-artifact-title">{snapshot.title}</div>
                  <div className="focus-artifact-meta">
                    {toFixedTime(snapshot.currentTime)} • f {snapshot.currentFrame} •{" "}
                    {getSideLabel(snapshot.side)}
                  </div>
                </div>
                <div className="focus-artifact-actions">
                  <a
                    className="focus-artifact-action"
                    href={snapshot.imageDataUrl}
                    download={toDownloadFileName(snapshot)}
                    onClick={(event) => {
                      event.preventDefault();
                      downloadFocusSnapshot(snapshot);
                    }}
                  >
                    Download
                  </a>
                  <button
                    type="button"
                    className="focus-artifact-action"
                    onClick={() => renameFocusSnapshot(snapshot.side, snapshot.id)}
                    aria-label={`Rename focus snapshot ${snapshot.title}`}
                    title="Rename snapshot"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="focus-artifact-action focus-artifact-action--danger"
                    onClick={() => removeFocusSnapshot(snapshot.side, snapshot.id)}
                    aria-label={`Delete focus snapshot ${snapshot.title}`}
                    title="Delete snapshot"
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="focus-artifacts-empty">No snapshots saved yet.</div>
          )}
        </div>
      </div>
      ) : null}

      {workspaceHasVideo && showDiagnostics ? (
        <StatusBar
          playback={{
            time: activePlayback.currentTime,
            frame: activeFrame,
            fps: activeStoreDrawingVideo?.fps || activePlayback.frameRate || FRAME_RATE_DEFAULT,
            duration: activeDuration || 0,
            isPlaying: activePlayback.isPlaying,
          }}
          timeline={{
            scrub: activeTimelineState.isScrubbing,
            hover: activeTimelineHoverMarker ? activeTimelineHoverMarker.label : null,
            zoom: activeTimelineState.zoom,
          }}
          drawing={{
            selectedTool: activeDrawing.selectedTool,
            selectedObjectId: activeDrawing.selectedObjectId,
            objectCount: activeDrawing.objects.length,
            undoSize: activeDrawing.canUndo ? 1 : 0,
            redoSize: activeDrawing.canRedo ? 1 : 0,
          }}
        />
      ) : null}

      {workspaceHasVideo ? (
      <Inspector
        selectedTool={activeDrawing.selectedTool}
        selectedObject={currentDrawingObject}
        canUndo={activeDrawing.canUndo}
        canRedo={activeDrawing.canRedo}
        currentObjects={activeDrawing.objects.length}
      />
      ) : null}
    </div>
  );
}
