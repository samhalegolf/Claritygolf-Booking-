import React, {
  ChangeEvent,
  DragEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NATIVE } from "../auth/apiFetch";
import { clamp, createId, FRAME_RATE_DEFAULT } from "./utils/frameMath";
import { videoAnalysisThemeCss } from "./theme/videoAnalysisTheme";
import { FocusPalette } from "./components/FocusPalette";
import { FocusWindow } from "./components/FocusWindow";
import { FocusAreaRect } from "./models/Focus";
import { FocusSnapshot, VideoAnalysis } from "./models/Analysis";
import { StatusBar } from "./components/StatusBar";
import { Timeline } from "./components/Timeline";
import { VideoCanvas } from "./components/VideoCanvas";
import {
  IconBack,
  IconCamera,
  IconEdit,
  IconRecord,
  IconSettings,
  IconLibrary,
  IconUpload,
} from "./components/VideoIcons";
import type {
  MotionLabSwing,
  SecondAngleLibrary,
} from "../../../motion-lab/src/embed/MotionLabView";
import { LibraryClipPanel, type LibraryClip } from "./components/LibraryClipPanel";
import {
  AnalysisRail,
  PlayerActionBar,
  PlayerToolRail,
  PlayerToolRailToggle,
} from "./components/PlayerVideoControls";
import { VideoSettingsSheet } from "./components/VideoSettingsSheet";
import { LivePoseLayer } from "./components/LivePoseLayer";
import { useSwingPhaseMarkers, type SwingPhaseClip } from "./hooks/useSwingPhaseMarkers";
import { ToolButton } from "./components/ToolButton";
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
  DEFAULT_RECORDING_ORIENTATION,
  describePreferredCamera,
  loadPreferredCamera,
  loadRecordingOrientation,
  openPreferredCameraStream,
  resolvePreferredCamera,
  savePreferredCamera,
  saveRecordingOrientation,
  trackMatchesOrientation,
  type CameraDevice,
  type PreferredCamera,
  type RecordingOrientation,
} from "./utils/cameraPreference";
import {
  buildVideoSlotKey,
  requestPersistentStorage,
} from "./utils/videoBlobStore";
import {
  createIndexedDbSavedVideoLibrary,
  importSavedVideoFromClarityCloud,
  linkSavedVideoAngles,
  listClarityCloudImportTransfers,
  LEGACY_UNASSIGNED_PLAYER_ID,
  pairSavedVideoAngles,
  refuseSavedVideoAngles,
  SavedVideoCloudError,
  SavedVideoLibraryError,
  type SavedVideoItem,
  type VideoTransferScope,
  type SavedVideoLibraryStore,
} from "./utils/savedVideoLibrary";
import { useAnalysisStore } from "./hooks/useAnalysisStore";
import { useDrawing } from "./hooks/useDrawing";
import { useMarkerThumbnails } from "./hooks/useMarkerThumbnails";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useCameraDevices } from "./hooks/useCameraDevices";
import { useLinkedPlayback } from "./hooks/useLinkedPlayback";
import { RemoteCameraPanel } from "../clarity-terminal/RemoteCameraPanel";
import type { TerminalTake } from "../clarity-terminal/terminalApi";
import { usePlayback } from "./hooks/usePlayback";
import { useTimeline } from "./hooks/useTimeline";
import { TimelineEngine } from "./engines/TimelineEngine";
import { ClarityVoiceTextPanel } from "../clarity-voice/ClarityVoiceTextPanel";
import {
  AnalysisViewRecorder,
  captureAnalysisFrame,
  getPreferredRecordingMimeType,
  getRecordingFileName,
  type AnalysisRecorderFrame,
  type AnalysisRecording,
} from "./utils/analysisRecorder";
import { PlayerVideo } from "./models/Video";
import { DrawingTool } from "./models/Drawing";
import { TimelineMarker } from "./models/Timeline";
import { activeLocale } from "../../lib/activeCountry";
import { t } from "../../lib/i18n";

/**
 * Give a freshly opened camera a moment to produce its first frame.
 *
 * Continuity Camera reports a live track well before it has any picture, and a
 * track in that gap reports no dimensions -- which would make the orientation
 * check below read "matches" for a camera it has not seen yet. Bounded and
 * never fatal: if the frame never arrives we carry on regardless, because
 * refusing to record is worse than recording without the check.
 */
const waitForFirstFrame = async (stream: MediaStream, timeoutMs = 1500) => {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { width, height } = track.getSettings();
    if (width && height) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const LEFT_ANALYSIS_SLOT = "comparison-left-slot";
const RIGHT_ANALYSIS_SLOT = "comparison-right-slot";

/** When a library clip was filmed, for a picker's second line. */
function describeClipDate(iso?: string): string {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(activeLocale(), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : t("No date recorded");
}

/** A file's own recording start, when its timestamp can be trusted. See loadClipFileForSide. */
function recordedAtFromFile(file: File, durationS?: number): string | undefined {
  const modified = file.lastModified;
  if (!Number.isFinite(modified) || modified <= 0) return undefined;
  if (Date.now() - modified < 2 * 60 * 1000) return undefined;
  // A camera writes the file as it stops, so the timestamp is the finish.
  return new Date(modified - (durationS || 0) * 1000).toISOString();
}

function getSideTitle(side: ComparisonSide) {
  return side === "left" ? t("Left") : t("Right");
}

function getSideLabel(side: ComparisonSide) {
  return side === "left" ? "L" : "R";
}

const MIN_ACTIVE_SELECTION_SIZE = 0.01;
const SNAPSHOT_STORAGE_WARNING_LIMIT = 12;
const SNAPSHOT_PREVIEW_WIDTH = 88;
const SNAPSHOT_PREVIEW_HEIGHT = 50;
/**
 * Scratch key for the recovery slot while nobody has been picked yet. It is
 * never written onto a saved video: saving without a player asks who it
 * belongs to first.
 */
const UNASSIGNED_WORKSPACE_ID = "unassigned";
const NO_LIBRARY_PLAYERS: readonly VideoWorkspaceLibraryPlayer[] = [];
/**
 * The box the freshly-captured frame shrinks into, in the composer.
 *
 * A box rather than a width: a tall crop -- a player from head to knee, which
 * is most of what a coach selects -- would otherwise make the composer taller
 * than the picture it is sitting on.
 */
const COMPOSER_THUMB_WIDTH = 132;
const COMPOSER_THUMB_HEIGHT = 96;
const CAPTURE_LIFT_DURATION = 520;

/**
 * A capture that has been taken but not yet filed.
 *
 * A screenshot on its own is half a note -- the coach took it because of
 * something they were about to say. So the capture lands in a composer next to
 * the picture it came from, holding the thumbnail and the note field together,
 * and only reaches the strip at the bottom once they press Save. Until then it
 * is not in the analysis at all, so an accidental capture costs a dismiss
 * rather than a delete.
 */
type SnapshotDraft = {
  snapshot: FocusSnapshot;
  note: string;
  /**
   * Where on the frame the capture came from, normalised to the canvas shell.
   * An area crop anchors the composer beside its own selection; a full frame
   * has no anchor and sits in the bottom-right corner of the picture.
   */
  anchor: FocusAreaRect | null;
  /** Width / height of the captured image, so the thumbnail keeps its shape. */
  aspect: number;
};

/** The captured pixels in flight, between the frame and the composer thumb. */
type CaptureLift = {
  id: number;
  side: ComparisonSide;
  imageDataUrl: string;
  /** Source rect on the canvas shell, normalised. The cut-out, for an area. */
  rect: FocusAreaRect;
  isCutout: boolean;
};
type SaveStatus = "idle" | "saving" | "sending" | "downloading" | "saved" | "error";
/**
 * A capture session on one side of the workspace.
 *
 * "connecting" is the gap between pressing Record and the saved camera handing
 * over a stream; "preview" is a camera that is open but not yet rolling, which
 * only the auto-start entry point produces -- the Record button connects and
 * rolls in one press.
 */
type RecordingStatus = "connecting" | "preview" | "recording" | "processing" | "error";
type ScreenRecordingStatus = "idle" | "recording" | "saving" | "error";
type CloudUploadFailureStage =
  | "Configuration"
  | "Connection"
  | "Preparing storage"
  | "Starting upload"
  | "Uploading"
  | "Verifying";

const CLOUD_FAILURE_STAGE_LABELS: Record<CloudUploadFailureStage, string> = {
  Configuration: t("Configuration"),
  Connection: t("Connection"),
  "Preparing storage": t("Preparing storage"),
  "Starting upload": t("Starting upload"),
  Uploading: t("Uploading"),
  Verifying: t("Verifying"),
};

interface CloudUploadFailureFeedback {
  title: string;
  reason: string;
  stage: CloudUploadFailureStage;
  safeErrorCode: string;
  retryable?: boolean;
  httpStatus?: number;
  actionRequired: boolean;
}

/** One video engine, two control sets: the coach console and the player's
    simplified workspace. */
export type VideoWorkspaceVariant = "coach" | "player";

/**
 * The motion lab, mounted over the workspace.
 *
 * Lazy because it carries three.js and the pose pipeline -- several hundred
 * kilobytes nobody downloads until a coach asks for 3D motion. The import
 * crosses into motion-lab/, which is allowed in this direction only: the lab
 * imports nothing from src/, so the booking app can never break the lab and
 * the lab's own tests stay meaningful. The pose worker and MediaPipe's WASM
 * it needs are served by the lab's Vite plugins, wired into vite.config.ts.
 *
 * Web only for now. The native build does not carry the WASM (34 MB in the
 * app bundle) and its Vite config does not run the lab's plugins, so the
 * button that opens this is hidden there rather than shown and broken.
 */
const MotionLabView = lazy(() =>
  import("../../../motion-lab/src/embed/MotionLabView").then((module) => ({
    default: module.MotionLabView,
  }))
);

const MOTION_LAB_AVAILABLE = !NATIVE;

export interface VideoWorkspaceNavigationContext {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  savedVideoId?: string;
  hasPlayerContext: boolean;
  reason: "toolbar-back" | "save" | "my-library-save";
}

export interface VideoWorkspacePlayerChoice {
  playerId: string;
  playerName: string;
}

/**
 * A player the "From library" search can find. One person's videos can be
 * filed under several ids (client id, email, phone), so all of them are given.
 */
export interface VideoWorkspaceLibraryPlayer {
  playerName: string;
  playerIds: string[];
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

export interface VideoWorkspaceProps {
  playerId?: string;
  playerName?: string;
  lessonId?: string;
  lessonTitle?: string;
  savedVideoId?: string;
  /**
   * The same swing from another camera, opened beside `savedVideoId` in
   * compare mode -- a same-swing pair from the library.
   */
  pairedSavedVideoId?: string;
  persistence?: Partial<VideoAnalysisPersistenceLayer>;
  savedVideoLibrary?: SavedVideoLibraryStore | null;
  /** Players with saved videos, for the "From library" search. */
  libraryPlayers?: readonly VideoWorkspaceLibraryPlayer[];
  onSavedVideoLibraryChange?: () => void;
  onNavigateBack?: (context: VideoWorkspaceNavigationContext) => void;
  onLocalSaveComplete?: (result: VideoWorkspaceSaveResult) => void | Promise<void>;
  onSaveAndSend?: (result: VideoWorkspaceSaveResult) => Promise<void>;
  onOpenCloudSettings?: () => void;
  /**
   * Asked on save when the workspace was opened without a player. Resolve with
   * the player the video belongs to, or null if the coach backed out.
   */
  onChoosePlayerForSave?: () => Promise<VideoWorkspacePlayerChoice | null>;
  /** Return false to tell the note panel the save failed and keep the text. */
  onSaveNote?: (text: string) => boolean | void | Promise<boolean | void>;
  /** Open the camera recorder as soon as the workspace mounts. */
  autoStartLiveRecording?: boolean;
  /**
   * A video the caller already has, loaded as soon as the workspace mounts.
   *
   * This is how the portal's record button works on a phone: the file input
   * has to be clicked inside the tap that started it or iOS ignores it, so the
   * picker opens before this component is even downloaded, and the chosen file
   * arrives here.
   */
  initialVideoFile?: File | null;
  /** Which control set to show. Defaults to the full coach console. */
  variant?: VideoWorkspaceVariant;
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
      : t("Your local video is safe. The cloud transfer service could not be reached.");

  return {
    title: t("Cloud upload could not start"),
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

const MOBILE_VIEWPORT_QUERY = "(max-width: 700px)";
const PORTRAIT_VIEWPORT_QUERY = "(orientation: portrait)";

const readVideoViewport = () => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { mobile: false, portrait: false };
  }
  return {
    mobile: window.matchMedia(MOBILE_VIEWPORT_QUERY).matches,
    portrait: window.matchMedia(PORTRAIT_VIEWPORT_QUERY).matches,
  };
};

/* Phone width and rotation. Compare needs the long edge of a phone, so the
   workspace asks for landscape rather than stacking two unreadable videos. */
function useVideoViewport() {
  const [viewport, setViewport] = useState(readVideoViewport);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const update = () => {
      const next = readVideoViewport();
      setViewport((previous) =>
        previous.mobile === next.mobile && previous.portrait === next.portrait
          ? previous
          : next
      );
    };

    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    update();

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return viewport;
}

export function VideoWorkspace({
  playerId,
  playerName,
  lessonId,
  lessonTitle,
  savedVideoId,
  pairedSavedVideoId,
  persistence,
  savedVideoLibrary,
  libraryPlayers = NO_LIBRARY_PLAYERS,
  onSavedVideoLibraryChange,
  onNavigateBack,
  onLocalSaveComplete,
  onSaveAndSend,
  onOpenCloudSettings,
  onChoosePlayerForSave,
  onSaveNote,
  autoStartLiveRecording,
  initialVideoFile,
  variant = "coach",
}: VideoWorkspaceProps) {
  const isPlayerVariant = variant === "player";
  const leftVideoRef = useRef<HTMLVideoElement>(null);
  const rightVideoRef = useRef<HTMLVideoElement>(null);
  const livePreviewRef = useRef<HTMLVideoElement>(null);
  const leftUploadInputRef = useRef<HTMLInputElement>(null);
  const rightUploadInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const resolvedPlayerId = playerId || UNASSIGNED_WORKSPACE_ID;
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
  const [focusArtifactEditingId, setFocusArtifactEditingId] = useState<string | null>(null);
  // The free box: dragged out over the video with nothing under the press,
  // it sits there doing nothing at all until a capture is asked for, and then
  // it is what gets captured. Nothing about it touches the focus window.
  const [captureBox, setCaptureBox] = useState<{ side: ComparisonSide; rect: FocusAreaRect } | null>(
    null
  );
  const captureBoxDragRef = useRef<{ side: ComparisonSide; start: { x: number; y: number } } | null>(
    null
  );
  const [captureAnimation, setCaptureAnimation] = useState<{ side: ComparisonSide; id: number } | null>(null);
  const captureAnimationTimerRef = useRef<number | null>(null);
  const [snapshotDraft, setSnapshotDraft] = useState<SnapshotDraft | null>(null);
  const [captureLift, setCaptureLift] = useState<CaptureLift | null>(null);
  const captureLiftRef = useRef<HTMLImageElement | null>(null);
  const composerThumbRef = useRef<HTMLImageElement | null>(null);
  const composerNoteRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  /** Throw away an unfiled capture. Declared here so Back can reach it. */
  const discardSnapshotDraft = useCallback(() => {
    setSnapshotDraft(null);
    setCaptureLift(null);
  }, []);
  const [leftMetadataReady, setLeftMetadataReady] = useState(false);
  const [rightMetadataReady, setRightMetadataReady] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<WorkspaceMode>("single");
  const [linkedPlayback, setLinkedPlayback] = useState(false);
  const [activeSide, setActiveSide] = useState<ComparisonSide>("left");
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [currentSavedVideoIds, setCurrentSavedVideoIds] = useState<Partial<Record<ComparisonSide, string>>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveMessage, setSaveMessage] = useState(t("Nothing to save yet."));
  const [dragTargetSide, setDragTargetSide] = useState<ComparisonSide | null>(null);
  const [intakeError, setIntakeError] = useState("");
  const [liveRecording, setLiveRecording] = useState<LiveRecordingSession | null>(null);
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  /** The side a Clarity Terminal panel is open on, if any. */
  const [remoteSide, setRemoteSide] = useState<ComparisonSide | null>(null);
  // The side whose panel is showing the library -- an empty one, or a loaded
  // one whose clip the pick will replace.
  const [librarySide, setLibrarySide] = useState<ComparisonSide | null>(null);
  // Which of the empty stage's two groups -- Upload or Connect -- has its
  // choices showing, and on which side.
  const [intakeGroup, setIntakeGroup] = useState<{
    side: ComparisonSide;
    kind: "upload" | "connect";
  } | null>(null);
  const toggleIntakeGroup = (side: ComparisonSide, kind: "upload" | "connect") =>
    setIntakeGroup((current) =>
      current?.side === side && current.kind === kind ? null : { side, kind }
    );
  // The workstation's default recording camera, chosen once in Video Settings.
  // Read on mount rather than taken from a prop: it belongs to this browser,
  // not to the player or lesson the workspace happens to be showing.
  const [preferredCamera, setPreferredCamera] = useState<PreferredCamera | null>(null);
  // Which way up the stage sits and what the camera is asked for. Portrait by
  // default: the workflow is a phone mounted upright behind the swing.
  const [recordingOrientation, setRecordingOrientation] = useState<RecordingOrientation>(
    DEFAULT_RECORDING_ORIENTATION
  );
  // Set when the camera hands back the other orientation from the one asked
  // for -- a Continuity Camera that only shoots landscape, say. The coach is
  // told rather than shown a preview that quietly disagrees with the file.
  const [orientationMismatch, setOrientationMismatch] = useState(false);
  const cameraDeviceList = useCameraDevices(!isPlayerVariant);
  // The player's drawing rail, tucked away until asked for. It is also the
  // mode switch for the video surface: closed means a drag scrubs frames,
  // open means a drag draws. One flag rather than two, because a player who
  // has put the tools away has said which of the two they wanted.
  const [toolRailOpen, setToolRailOpen] = useState(false);
  // Coach-only. Everything that isn't drawing or transport -- compare mode,
  // linked playback, sync, screen recording, the library save, diagnostics,
  // swapping the active clip -- lives behind this gear instead of an
  // always-on console bar.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The swing handed to the motion lab, or null while it is closed. Held in
  // state so its identity is stable: the lab re-detects when it changes.
  const [motionLabSwing, setMotionLabSwing] = useState<MotionLabSwing | null>(null);
  // In compare mode, the other panel's clip: the same swing from the other
  // camera, fused with the first for depth. Null in single mode.
  const [motionLabSecondAngle, setMotionLabSecondAngle] = useState<MotionLabSwing | null>(null);
  // Whose library the lab's second-angle picker lists.
  const [motionLabPlayerId, setMotionLabPlayerId] = useState<string | null>(null);
  const [motionLabOpen, setMotionLabOpen] = useState(false);
  const [motionLabError, setMotionLabError] = useState<string | null>(null);
  // The right rail's two live reads. Shared by both panels in compare mode,
  // like the drawing rail: a toggle is a way of looking, not a clip setting.
  const [showBodyMarkers, setShowBodyMarkers] = useState(false);
  const [showGroundForce, setShowGroundForce] = useState(false);
  // Each panel's slot for the ground-force card. Stable callbacks, so React
  // does not detach and reattach the ref on every render.
  const [forceHosts, setForceHosts] = useState<Record<ComparisonSide, HTMLElement | null>>({
    left: null,
    right: null,
  });
  const setLeftForceHost = useCallback(
    (element: HTMLElement | null) => setForceHosts((current) => ({ ...current, left: element })),
    []
  );
  const setRightForceHost = useCallback(
    (element: HTMLElement | null) => setForceHosts((current) => ({ ...current, right: element })),
    []
  );

  const timelineEngine = useMemo(() => new TimelineEngine(), []);
  const modeIsCompare = comparisonMode === "compare";
  const bothSidesLoaded = Boolean(leftMountedSource && rightMountedSource);
  const { setOffset: setLinkedOffset } = useLinkedPlayback({
    enabled: linkedPlayback && modeIsCompare && bothSidesLoaded,
    leftRef: leftVideoRef,
    rightRef: rightVideoRef,
    sourceKey: `${comparisonMode}|${leftMountedSource}|${rightMountedSource}`,
  });
  const workspaceHasVideo = Boolean(playerVideoLeft || playerVideoRight);
  const { mobile: isMobileViewport, portrait: isPortraitViewport } = useVideoViewport();
  // Desktop keeps Split View exactly as it is. A phone held upright gets the
  // rotate prompt instead, and side by side once it is turned.
  const needsCompareRotation = modeIsCompare && isMobileViewport && isPortraitViewport;

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

  /**
   * Release the camera when the workspace goes away.
   *
   * Unmount only, and that is load-bearing. Keyed on `liveStream`, the cleanup
   * ran on every change of it -- including the render that first published a
   * new stream. By then `mediaRecorderRef` already held the recorder that had
   * just been started on that very stream, so the teardown stopped the tracks
   * it was recording from: the camera lit up, the preview stayed black, and
   * the file came back empty. The ref keeps the current stream reachable
   * without making this effect re-run.
   */
  const liveStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    liveStreamRef.current = liveStream;
  }, [liveStream]);
  useEffect(
    () => () => {
      mediaRecorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      stopLiveStream(liveStreamRef.current);
    },
    [stopLiveStream]
  );

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
  // The body-analysis rail is coach console only, like the 3D lab it opens.
  const showAnalysisRail = !isPlayerVariant;
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
      setSaveMessage(t("Nothing to save yet."));
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

  // Each panel's markers follow the swing the motion lab finds in its clip.
  // Web coach console only, for the same reason as the 3D button: the pose
  // worker and its WASM are served by the web build.
  const swingPhasesEnabled = MOTION_LAB_AVAILABLE && !isPlayerVariant;
  const leftPhaseClip = useMemo<SwingPhaseClip | null>(
    () =>
      playerVideoLeft
        ? {
            id: playerVideoLeft.id,
            sourceUrl: playerVideoLeft.sourceUrl,
            duration: playerVideoLeft.duration || leftCurrentDuration || 0,
            fps: playerVideoLeft.fps,
          }
        : null,
    // Re-detect on a new clip, not on every duration tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playerVideoLeft?.id, playerVideoLeft?.sourceUrl]
  );
  const rightPhaseClip = useMemo<SwingPhaseClip | null>(
    () =>
      playerVideoRight
        ? {
            id: playerVideoRight.id,
            sourceUrl: playerVideoRight.sourceUrl,
            duration: playerVideoRight.duration || rightCurrentDuration || 0,
            fps: playerVideoRight.fps,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playerVideoRight?.id, playerVideoRight?.sourceUrl]
  );
  const getDefaultMarkers = useCallback(
    (duration: number) => timelineEngine.getDefaultMarkers(duration),
    [timelineEngine]
  );
  const leftPhases = useSwingPhaseMarkers({
    enabled: swingPhasesEnabled,
    clip: leftPhaseClip,
    markers: leftMarkers,
    defaults: getDefaultMarkers,
    apply: (next) => syncMarkersWithAnalysis("left", next),
  });
  const rightPhases = useSwingPhaseMarkers({
    enabled: swingPhasesEnabled && modeIsCompare,
    clip: rightPhaseClip,
    markers: rightMarkers,
    defaults: getDefaultMarkers,
    apply: (next) => syncMarkersWithAnalysis("right", next),
  });

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

    // Linked sides need nothing here: useLinkedPlayback mirrors whichever
    // side is played or paused onto the other.
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
    modeIsCompare,
    playerVideoLeft,
    playerVideoRight,
    playPauseSide,
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
    const targetTime = sourceFrame / targetFps;
    // Lining the sides up is a new gap on purpose; the link keeps this one
    // from here rather than dragging the source back to the old one.
    setLinkedOffset(
      sourceSide === "left"
        ? targetTime - sourcePlayback.currentTime
        : sourcePlayback.currentTime - targetTime
    );
    targetPlayback.seekTo(targetTime);
  }, [effectiveActiveSide, leftPlayback, setLinkedOffset, modeIsCompare, playerVideoLeft, playerVideoRight, rightPlayback]);

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
    /**
     * `recordedAt` is when the camera started, when the caller knows it -- a
     * live recording does. Otherwise it is read from the file's own
     * timestamp, but only when that timestamp predates opening the file: a
     * phone's gallery often stamps a file as it hands it over, and two clips
     * picked together would then look filmed together.
     */
    async (side: ComparisonSide, file: File, recordedAt?: string) => {
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
        recordedAt: recordedAt ?? recordedAtFromFile(file, loaded.duration),
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
      setSaveMessage(t("Clip ready to save."));
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
        setIntakeError(t("Drop a video file to upload."));
        return;
      }

      try {
        await loadClipFileForSide(side, file);
        setIntakeError("");
        setSaveStatus("idle");
        setSaveMessage(t("Clip ready to save."));
      } catch (error) {
        setIntakeError(t("Upload failed. Try a different video file."));
        setSaveStatus("error");
        setSaveMessage(t("Upload failed. Try a different video file."));
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
    /**
     * `placement` puts the video on a chosen side rather than the layout it
     * was saved in. As one of a same-swing pair (`pair`) that is compare mode
     * with linked playback; otherwise the layout on screen stays as it is.
     * A placed video that is only in Clarity Cloud is downloaded first.
     */
    async (
      targetSavedVideoId: string,
      placement?: { side: ComparisonSide; pair: boolean }
    ) => {
      if (!savedVideoStore) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_LOAD_FAILED",
          t("Saved video library is unavailable in this browser.")
        );
      }

      let item = await savedVideoStore.getItem(targetSavedVideoId);
      if (!item && placement) {
        // Picked from the library, or the other angle of a pair: it may only
        // be in Clarity Cloud so far.
        setSaveStatus("downloading");
        setSaveMessage(t("Downloading from Clarity Cloud..."));
        item = await importSavedVideoFromClarityCloud(targetSavedVideoId, savedVideoStore, {
          scope: isPlayerVariant ? "player" : "coach",
        });
        onSavedVideoLibraryChange?.();
      }
      if (!item) {
        throw new SavedVideoLibraryError(
          "SAVED_VIDEO_METADATA_MISSING",
          t("Saved video metadata could not be found.")
        );
      }

      let blob = await savedVideoStore.getBlob(targetSavedVideoId);
      if (!blob && (item.cloud?.status === "ready" || item.cloud?.status === "imported")) {
        setSaveStatus("downloading");
        setSaveMessage(t("Downloading from Clarity Cloud..."));
        item = await importSavedVideoFromClarityCloud(targetSavedVideoId, savedVideoStore, {
          // The player variant runs on a player session, which cannot reach
          // the admin routes at all in the native app.
          scope: isPlayerVariant ? "player" : "coach",
        });
        onSavedVideoLibraryChange?.();
        blob = await savedVideoStore.getBlob(item.savedVideoId);
      }
      if (!blob) {
        setSaveStatus("error");
        setSaveMessage(t("Device copy unavailable. Saved card was kept for recovery."));
        return;
      }

      const side = placement?.side || item.sourceSide || "left";
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
        recordedAt: item.source.recordedAt,
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
      if (placement) {
        if (placement.pair) {
          setComparisonMode("compare");
          setActiveSide("left");
          setLinkedPlayback(true);
        }
        setCurrentSavedVideoIds((current) => ({ ...current, [side]: item.savedVideoId }));
      } else {
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
      }
      setActiveSideInCompare(side);

      persistenceLayer.videoStore
        ?.putVideo(buildVideoSlotKey(item.playerId, side, item.lessonId), restoredVideo, blob)
        .catch(() => {
          // Saved library stays intact even if the recovery copy cannot be rebuilt.
        });

      setSaveStatus("idle");
      setSaveMessage(t("Saved video loaded."));
    },
    [
      isPlayerVariant,
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

  /**
   * Takes from a Clarity Terminal, already in Clarity Cloud and filed under
   * this player. They are brought into this device's library and opened.
   *
   * One camera fills the side the coach recorded from, in the layout they
   * already have. Two cameras arrive as a compare pair, left and right, the
   * way the terminal filed them.
   */
  const loadTerminalTakes = useCallback(
    async (takes: TerminalTake[]) => {
      if (!savedVideoStore) {
        throw new Error(t("Device video storage is unavailable in this browser."));
      }
      const requestedSide = remoteSide || "left";
      for (const take of takes) {
        let item = await importSavedVideoFromClarityCloud(take.savedVideoId, savedVideoStore);
        if (takes.length === 1) {
          item = {
            ...item,
            sourceSide: requestedSide,
            workspaceSnapshot: {
              ...item.workspaceSnapshot,
              mode: requestedSide === "right" ? "compare" : comparisonMode,
              activeSide: requestedSide,
              focusWindowSide: requestedSide,
            },
          };
          await savedVideoStore.putItem(item);
        }
        await restoreSavedVideo(item.savedVideoId);
      }
      // Two cameras from one press are one swing from two angles.
      if (takes.length === 2) {
        await linkSavedVideoAngles(savedVideoStore, takes[0].savedVideoId, takes[1].savedVideoId);
      }
      onSavedVideoLibraryChange?.();
      setRemoteSide(null);
    },
    [comparisonMode, onSavedVideoLibraryChange, remoteSide, restoreSavedVideo, savedVideoStore]
  );

  const openedSavedVideoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!savedVideoId || openedSavedVideoRef.current === savedVideoId) return;
    openedSavedVideoRef.current = savedVideoId;
    // A same-swing pair opens side by side, the angle asked for on the left.
    const opening = pairedSavedVideoId
      ? restoreSavedVideo(savedVideoId, { side: "left", pair: true }).then(() =>
          restoreSavedVideo(pairedSavedVideoId, { side: "right", pair: true })
        )
      : restoreSavedVideo(savedVideoId);
    void opening.catch((error) => {
      setSaveStatus("error");
      setSaveMessage(
        error instanceof SavedVideoLibraryError
          ? error.message
          : t("Saved video could not be loaded.")
      );
      // eslint-disable-next-line no-console
      console.error("Saved video load failed", error);
    });
  }, [pairedSavedVideoId, restoreSavedVideo, savedVideoId]);

  const resolvedCamera = useMemo(
    () => resolvePreferredCamera(cameraDeviceList.devices, preferredCamera),
    [cameraDeviceList.devices, preferredCamera]
  );

  // Both recording preferences belong to this browser, so they are read once
  // on mount rather than tracked through props.
  useEffect(() => {
    setPreferredCamera(loadPreferredCamera());
    setRecordingOrientation(loadRecordingOrientation());
  }, []);

  /**
   * Open the coach's saved camera, and only that one.
   *
   * When it cannot be opened the answer is "camera not connected" -- not the
   * MacBook camera, not Desk View, not whatever the browser would have picked.
   * The coach has already said which picture they want, and quietly recording
   * a different one is a mistake they would only discover on playback.
   *
   * The device id is pinned with `exact` on every attempt, which is what makes
   * it safe to try a camera the device list has not mentioned. That matters:
   * a Continuity Camera iPhone is often not advertised until something asks
   * for a camera, so gating the attempt on enumeration was a closed loop --
   * the phone stayed absent because nothing ever woke it, and nothing ever
   * woke it because it was absent.
   */
  const connectPreferredCamera = useCallback(
    async (side: ComparisonSide): Promise<MediaStream | null> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setLiveRecording({
          side,
          status: "error",
          error: t("Live recording is not available in this browser."),
          startedAt: null,
        });
        return null;
      }
      if (!preferredCamera) {
        setLiveRecording({
          side,
          status: "error",
          error: t("Choose a recording camera in Video Settings."),
          startedAt: null,
        });
        return null;
      }

      setLiveRecording({ side, status: "connecting", error: null, startedAt: null });
      stopLiveStream(liveStream);
      setLiveStream(null);

      const { stream, blocked } = await openPreferredCameraStream<MediaStream>({
        preferred: preferredCamera,
        orientation: recordingOrientation,
        openStream: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        // Re-enumerating here, after the first attempt, is when a phone that
        // just woke finally shows up in the list.
        listCameras: () => cameraDeviceList.refresh(),
      });

      if (!stream) {
        setLiveRecording({
          side,
          status: "error",
          error: blocked
            ? t("Camera access was blocked for this site.")
            : t("{camera} is not connected.", { camera: describePreferredCamera(preferredCamera) }),
          startedAt: null,
        });
        return null;
      }

      // The phone is awake now, so the list it was missing from is stale.
      void cameraDeviceList.refresh();
      await waitForFirstFrame(stream);
      setOrientationMismatch(
        !trackMatchesOrientation(
          stream.getVideoTracks()[0]?.getSettings(),
          recordingOrientation
        )
      );
      setLiveStream(stream);
      setLiveRecording({ side, status: "preview", error: null, startedAt: null });
      setActiveSideInCompare(side);
      return stream;
    },
    [
      cameraDeviceList,
      liveStream,
      preferredCamera,
      recordingOrientation,
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

  /** Roll on an already-open stream. */
  const beginMediaRecorder = useCallback(
    (stream: MediaStream, recordingSide: ComparisonSide) => {
      if (typeof MediaRecorder === "undefined") {
        setLiveRecording({
          side: recordingSide,
          status: "error",
          error: t("Recording is not available in this browser."),
          startedAt: null,
        });
        return;
      }

      try {
        const mimeType = getPreferredRecordingMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        // Stamped as it starts, so a second camera started with it pairs with it.
        const recordingStartedAt = new Date().toISOString();
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
                  error: t("Recording failed."),
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
                      error: t("Recording did not capture any video."),
                      startedAt: null,
                    }
                  : current
              );
              return;
            }

            const file = new File(
              [blob],
              getRecordingFileName(`live-recording-${recordingSide}`, blob.type || blobType),
              { type: blob.type || blobType }
            );
            await loadClipFileForSide(recordingSide, file, recordingStartedAt);
            setSaveStatus("idle");
            setSaveMessage(t("Recording ready to save."));
            // The loaded file now owns this side's normal VideoCanvas. Releasing
            // the stream and session lets playback replace the preview in place.
            stopLiveStream(stream);
            setLiveStream(null);
            setLiveRecording(null);
          })();
        };

        recorder.start(250);
        setLiveRecording({
          side: recordingSide,
          status: "recording",
          error: null,
          startedAt: Date.now(),
        });
      } catch (error) {
        setLiveRecording({
          side: recordingSide,
          status: "error",
          error: error instanceof Error ? error.message : t("Could not start recording."),
          startedAt: null,
        });
      }
    },
    [loadClipFileForSide, stopLiveStream]
  );

  /**
   * The everyday Record button: one press connects the saved camera and starts
   * rolling. There is no source to choose here and no preview to step through,
   * because the camera was chosen once already in Video Settings.
   */
  const startLiveRecording = useCallback(
    async (side: ComparisonSide) => {
      if (
        liveRecording?.status === "connecting" ||
        liveRecording?.status === "recording" ||
        liveRecording?.status === "processing"
      ) {
        return;
      }
      // A camera left open by the auto-start entry point just rolls.
      if (liveStream && liveRecording?.side === side && liveRecording.status === "preview") {
        beginMediaRecorder(liveStream, side);
        return;
      }
      const stream = await connectPreferredCamera(side);
      if (stream) {
        beginMediaRecorder(stream, side);
      }
    },
    [beginMediaRecorder, connectPreferredCamera, liveRecording, liveStream]
  );

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

  /**
   * Choosing a camera in Video Settings deliberately replaces the previous
   * default. Any camera already open belongs to the old choice, so it is let
   * go; the next Record opens the new one.
   */
  const handleSelectCamera = useCallback(
    (device: CameraDevice) => {
      const next: PreferredCamera = { deviceId: device.deviceId, label: device.label };
      savePreferredCamera(next);
      setPreferredCamera(next);
      setOrientationMismatch(false);
      if (
        liveRecording &&
        liveRecording.status !== "recording" &&
        liveRecording.status !== "processing"
      ) {
        closeLiveRecording();
      }
    },
    [closeLiveRecording, liveRecording]
  );

  /**
   * Orientation is asked for when the camera is opened, so a stream that is
   * already running was opened the other way round. Let it go rather than
   * leave a preview that no longer matches the setting.
   */
  const handleSelectOrientation = useCallback(
    (orientation: RecordingOrientation) => {
      saveRecordingOrientation(orientation);
      setRecordingOrientation(orientation);
      setOrientationMismatch(false);
      if (
        liveRecording &&
        liveRecording.status !== "recording" &&
        liveRecording.status !== "processing"
      ) {
        closeLiveRecording();
      }
    },
    [closeLiveRecording, liveRecording]
  );

  // A file the caller picked before this component existed. Same single-shot
  // rule as the recorder below: loading it again on every render would throw
  // away whatever the player has drawn on it.
  const initialFileLoadedRef = useRef(false);
  useEffect(() => {
    if (!initialVideoFile || initialFileLoadedRef.current) return;
    initialFileLoadedRef.current = true;
    void loadClipFileForSide("left", initialVideoFile).catch(() => {
      // loadClipFileForSide surfaces its own failure in the workspace.
    });
  }, [initialVideoFile, loadClipFileForSide]);

  // Entering straight from the Profile tab's record button. This one opens the
  // camera and stops there rather than rolling: the coach asked for the
  // recorder, not for a recording that has already started without them. The
  // ref keeps it to a single shot, so closing the recorder does not
  // immediately reopen it.
  const autoRecordStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStartLiveRecording || autoRecordStartedRef.current) return;
    if (workspaceHasVideo) return;
    autoRecordStartedRef.current = true;
    void connectPreferredCamera("left");
  }, [autoStartLiveRecording, connectPreferredCamera, workspaceHasVideo]);

  /**
   * Drag the video itself to move through it, frame by frame.
   *
   * On a phone the timeline is a few hundred pixels wide for the whole clip,
   * so a thumb on it lands within about a tenth of a second of where it was
   * aimed -- fine for finding the swing, useless for looking at the moment of
   * impact. Dragging the picture instead spends the same pixels on far less
   * time: SCRUB_PX_PER_FRAME apart means a full-width swipe covers roughly two
   * seconds, and a single frame is a deliberate, reachable movement.
   *
   * The gesture is horizontal-only on purpose. A vertical drag belongs to the
   * page, and claiming it here would break scrolling everywhere this workspace
   * is embedded.
   */
  const SCRUB_PX_PER_FRAME = 7;
  const SCRUB_START_SLOP = 8;
  const scrubGestureRef = useRef<{
    side: ComparisonSide;
    startX: number;
    startY: number;
    startTime: number;
    engaged: boolean;
    /** Set once the press has travelled far enough to be a drag of any kind,
     *  including one this gesture then declines. It is what stops a scroll
     *  from being released as a tap and playing the video. */
    moved: boolean;
  } | null>(null);

  // Closed rail means the surface is a scrubber. A focus selection is a drag
  // of its own and always wins.
  const canScrubByDrag = isPlayerVariant && !toolRailOpen && !focusSelectionMode;

  // The box exists to be captured, and the player has no capture, so there it
  // would only be a rectangle that does nothing.
  const canDragCaptureBox = !isPlayerVariant && !focusSelectionMode;

  const scrubToOffset = useCallback(
    (side: ComparisonSide, deltaX: number) => {
      const gesture = scrubGestureRef.current;
      if (!gesture) return;
      const playback = side === "left" ? leftPlayback : rightPlayback;
      const video = side === "left" ? playerVideoLeft : playerVideoRight;
      const fps = video?.fps || playback.frameRate || FRAME_RATE_DEFAULT;
      const frames = Math.round(deltaX / SCRUB_PX_PER_FRAME);
      // Dragging right moves forward, the same direction the playhead travels.
      const target = gesture.startTime + frames / fps;
      const duration = playback.duration || 0;
      playback.seekTo(Math.max(0, duration > 0 ? Math.min(target, duration) : target));
    },
    [leftPlayback, playerVideoLeft, playerVideoRight, rightPlayback]
  );

  const handleCanvasPointerDown = useCallback(
    (
      side: ComparisonSide,
      point: { x: number; y: number },
      meta: { pointerType: string }
    ) => {
      const hasVideo = side === "left" ? !!playerVideoLeft : !!playerVideoRight;
      if (!hasVideo) {
        return;
      }
      if (canScrubByDrag) {
        const playback = side === "left" ? leftPlayback : rightPlayback;
        const element = (side === "left" ? leftVideoRef : rightVideoRef).current;
        setActiveSideInCompare(side);
        scrubGestureRef.current = {
          side,
          startX: point.x,
          startY: point.y,
          // The element, not the mirrored state: a drag measures from where
          // the video actually is, and asking it directly cannot be a frame
          // behind whatever the last render happened to see.
          startTime: element ? element.currentTime : playback.currentTime,
          engaged: false,
          moved: false,
        };
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
      const drawing = side === "left" ? leftDrawing : rightDrawing;
      // Nothing selected, nothing under the press, no tool in hand: this is a
      // box being drawn round something, not a shape.
      if (canDragCaptureBox && drawing.selectedTool === "select" && !drawing.hitTest(point)) {
        setActiveSideInCompare(side);
        drawing.selectObject(null);
        const overlay = side === "left" ? leftOverlayDimensions : rightOverlayDimensions;
        captureBoxDragRef.current = { side, start: normalizePoint(point, overlay) };
        setCaptureBox(null);
        return;
      }
      setActiveSideInCompare(side);
      drawing.pointerDown(point, meta);
    },
    [
      canDragCaptureBox,
      canScrubByDrag,
      focusSelectionMode,
      leftDrawing,
      leftOverlayDimensions,
      leftPlayback,
      playerVideoLeft,
      rightDrawing,
      rightOverlayDimensions,
      rightPlayback,
      setActiveSideInCompare,
      playerVideoRight,
    ]
  );

  // The hover affordance only makes sense where a press would actually draw
  // or grab. While the surface is a scrubber, or while a focus area is being
  // dragged out, a press does something else entirely, so the handles stay
  // down rather than promising a move that will not happen.
  const handleCanvasPointerHover = useCallback(
    (side: ComparisonSide, point: { x: number; y: number } | null) => {
      const drawing = side === "left" ? leftDrawing : rightDrawing;
      drawing.pointerHover(canScrubByDrag || focusSelectionMode ? null : point);
    },
    [canScrubByDrag, focusSelectionMode, leftDrawing, rightDrawing]
  );

  const handleCanvasPointerMove = useCallback(
    (side: ComparisonSide, point: { x: number; y: number }) => {
      const boxDrag = captureBoxDragRef.current;
      if (boxDrag && boxDrag.side === side) {
        const overlay = side === "left" ? leftOverlayDimensions : rightOverlayDimensions;
        setCaptureBox({
          side,
          rect: buildRectFromDrag(boxDrag.start, normalizePoint(point, overlay)),
        });
        return;
      }
      const gesture = scrubGestureRef.current;
      if (gesture && gesture.side === side) {
        const deltaX = point.x - gesture.startX;
        if (!gesture.engaged) {
          // Wait until the drag has committed to an axis. Anything steeper
          // than 45 degrees is a scroll, not a scrub -- and is still a drag,
          // so it is marked moved and left to run its course rather than
          // released as a tap that would start the video playing.
          const deltaY = point.y - gesture.startY;
          if (Math.abs(deltaY) > SCRUB_START_SLOP && Math.abs(deltaY) > Math.abs(deltaX)) {
            gesture.moved = true;
            return;
          }
          if (Math.abs(deltaX) < SCRUB_START_SLOP) return;
          gesture.engaged = true;
          gesture.moved = true;
          // Scrubbing a playing video fights the clock. Stop it, and leave it
          // stopped -- the frame they dragged to is the one they wanted.
          const playback = side === "left" ? leftPlayback : rightPlayback;
          playback.pause();
        }
        scrubToOffset(side, deltaX);
        return;
      }
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
      leftPlayback,
      rightDrawing,
      rightOverlayDimensions,
      rightPlayback,
      scrubToOffset,
    ]
  );

  const handleCanvasPointerUp = useCallback(
    (side: ComparisonSide, point: { x: number; y: number }) => {
      if (captureBoxDragRef.current && captureBoxDragRef.current.side === side) {
        captureBoxDragRef.current = null;
        // A press that never became a drag is a click on empty video, and a
        // click on empty video is how the box is put away.
        setCaptureBox((current) =>
          current &&
          current.rect.width > MIN_ACTIVE_SELECTION_SIZE &&
          current.rect.height > MIN_ACTIVE_SELECTION_SIZE
            ? current
            : null
        );
        return;
      }
      const gesture = scrubGestureRef.current;
      if (gesture && gesture.side === side) {
        scrubGestureRef.current = null;
        // A press that never became a drag is a tap, and a tap on a video
        // means play or pause. Nothing else on this surface needs a click.
        if (!gesture.moved) {
          playPauseSide(side);
        }
        return;
      }
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
      playPauseSide,
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
    // An unfiled capture is the newest thing on screen, so Back discards it
    // first -- the same order the coach built it in.
    if (snapshotDraft) {
      discardSnapshotDraft();
      return;
    }
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
    discardSnapshotDraft,
    focusPaletteOpen,
    showFocusWindow,
    focusSelectionMode,
    clearFocusSelection,
    onNavigateBack,
    playerId,
    snapshotDraft,
    updateMode,
  ]);

  const canGoBack =
    Boolean(snapshotDraft) ||
    activeDrawing.isDrawingActionActive ||
    Boolean(focusSelectionMode) ||
    focusPaletteOpen ||
    showFocusWindow ||
    comparisonMode === "compare" ||
    Boolean(onNavigateBack);

  const analysisRecorderRef = useRef<AnalysisViewRecorder | null>(null);
  const [screenRecordingStatus, setScreenRecordingStatus] = useState<ScreenRecordingStatus>("idle");
  const [screenRecordingMessage, setScreenRecordingMessage] = useState("");
  // The recorder reads this on every frame, so it always draws the current
  // video and drawings without needing to be restarted when they change.
  const recorderFrameRef = useRef<AnalysisRecorderFrame>({
    video: null,
    objects: [],
    overlay: { width: 1, height: 1 },
  });
  recorderFrameRef.current = {
    video: effectiveActiveSide === "left" ? leftVideoRef.current : rightVideoRef.current,
    objects: activeDrawing.objects,
    overlay: effectiveActiveSide === "left" ? leftOverlayDimensions : rightOverlayDimensions,
  };

  const clearActiveDrawing = useCallback(() => {
    if (!activeDrawing.objects.length) {
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

  const playCaptureAnimation = useCallback((side: ComparisonSide) => {
    if (captureAnimationTimerRef.current !== null) {
      window.clearTimeout(captureAnimationTimerRef.current);
    }
    setCaptureAnimation({ side, id: Date.now() });
    captureAnimationTimerRef.current = window.setTimeout(() => {
      setCaptureAnimation(null);
      captureAnimationTimerRef.current = null;
    }, 520);
  }, []);

  useEffect(
    () => () => {
      if (captureAnimationTimerRef.current !== null) {
        window.clearTimeout(captureAnimationTimerRef.current);
      }
    },
    []
  );

  /** Write a finished capture into the side's analysis. */
  const fileSnapshot = useCallback(
    (snapshot: FocusSnapshot, note: string) => {
      const store = snapshot.side === "left" ? leftStore : rightStore;
      store.updateAnalysis({
        focusSnapshots: [
          ...(store.analysis.focusSnapshots || []),
          { ...snapshot, note: note.trim() },
        ],
      });
    },
    [leftStore, rightStore]
  );

  /**
   * Hold a fresh capture next to the picture it came from.
   *
   * Capturing again while one is still open files the open one rather than
   * throwing away whatever has been typed into it -- a second capture is the
   * coach moving on, not undoing.
   */
  const stageSnapshotDraft = useCallback(
    (snapshot: FocusSnapshot, anchor: FocusAreaRect | null, aspect: number) => {
      setSnapshotDraft((pending) => {
        if (pending) {
          fileSnapshot(pending.snapshot, pending.note);
        }
        return { snapshot, note: "", anchor, aspect: aspect > 0 ? aspect : 16 / 9 };
      });
      setCaptureLift({
        id: Date.now(),
        side: snapshot.side,
        imageDataUrl: snapshot.imageDataUrl,
        rect: anchor || { x: 0, y: 0, width: 1, height: 1 },
        isCutout: Boolean(anchor),
      });
    },
    [fileSnapshot]
  );

  const commitSnapshotDraft = useCallback(() => {
    if (!snapshotDraft) {
      return;
    }
    fileSnapshot(snapshotDraft.snapshot, snapshotDraft.note);
    setSnapshotDraft(null);
    setCaptureLift(null);
    setFocusArtifactEditingId(null);
    setFocusArtifactExpandedId(null);
  }, [fileSnapshot, snapshotDraft]);

  const draftId = snapshotDraft?.snapshot.id;

  /**
   * Keep the composer inside the picture.
   *
   * Where it wants to be is decided by the crop, and a crop low on the frame
   * or hard against an edge would push it out of the shell, which clips. So it
   * is placed by the crop and then nudged back in by however much it overhangs
   * -- measured, because the height depends on the shape of what was captured.
   *
   * Before the flight, not after: the capture is animated into this thumbnail,
   * and it has to be where it is going to stay before that distance is taken.
   */
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    composer.style.removeProperty("transform");
    const shell = composer.offsetParent as HTMLElement | null;
    if (!shell) {
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    const rect = composer.getBoundingClientRect();
    const margin = 8;
    let shiftX = 0;
    let shiftY = 0;
    if (rect.bottom > shellRect.bottom - margin) {
      shiftY = shellRect.bottom - margin - rect.bottom;
    }
    if (rect.top + shiftY < shellRect.top + margin) {
      shiftY = shellRect.top + margin - rect.top;
    }
    if (rect.right > shellRect.right - margin) {
      shiftX = shellRect.right - margin - rect.right;
    }
    if (rect.left + shiftX < shellRect.left + margin) {
      shiftX = shellRect.left + margin - rect.left;
    }
    if (shiftX || shiftY) {
      composer.style.transform = `translate(${Math.round(shiftX)}px, ${Math.round(shiftY)}px)`;
    }
  }, [draftId]);

  // The composer exists to be typed into, so it arrives with the caret in it.
  useEffect(() => {
    if (!draftId) {
      return;
    }
    composerNoteRef.current?.focus();
  }, [draftId]);

  /**
   * The capture flies from the frame into the composer's thumbnail.
   *
   * Measured rather than declared: the composer sits wherever the crop put it,
   * so the distance and the amount to shrink by are only knowable once both
   * ends are on screen. It lifts a little first, then reduces -- the picture
   * coming off the frame and settling into the note.
   */
  useEffect(() => {
    if (!captureLift) {
      return undefined;
    }
    const liftElement = captureLiftRef.current;
    if (!liftElement) {
      return undefined;
    }
    let cancelled = false;
    const settle = () => {
      if (cancelled) return;
      setCaptureLift((current) => (current && current.id === captureLift.id ? null : current));
    };
    if (typeof liftElement.animate !== "function") {
      const timer = window.setTimeout(settle, CAPTURE_LIFT_DURATION);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    const from = liftElement.getBoundingClientRect();
    const target = composerThumbRef.current?.getBoundingClientRect();
    const scale = target && from.width > 0 ? target.width / from.width : 0.25;
    const deltaX = target ? target.left - from.left : 0;
    const deltaY = target ? target.top - from.top : 0;
    const animation = liftElement.animate(
      [
        { offset: 0, transform: "translate(0px, 0px) scale(1)", opacity: 1 },
        {
          offset: 0.28,
          transform: `translate(${-from.width * 0.03}px, ${-from.height * 0.05}px) scale(1.06)`,
          opacity: 1,
        },
        {
          offset: 1,
          transform: `translate(${deltaX}px, ${deltaY}px) scale(${scale})`,
          opacity: 0.9,
        },
      ],
      {
        duration: CAPTURE_LIFT_DURATION,
        easing: "cubic-bezier(0.22, 0.68, 0.24, 1)",
        fill: "forwards",
      }
    );
    animation.addEventListener("finish", settle);
    return () => {
      cancelled = true;
      animation.cancel();
    };
  }, [captureLift]);

  const removeFocusSnapshot = useCallback(
    (side: ComparisonSide, snapshotId: string) => {
      setFocusArtifactExpandedId((current) => (current === snapshotId ? null : current));
      setFocusArtifactEditingId((current) => (current === snapshotId ? null : current));
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
      const nextTitle = window.prompt(t("Rename snapshot"), target.title);
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

  const updateFocusSnapshotNote = useCallback(
    (side: ComparisonSide, snapshotId: string, note: string) => {
      const activeStore = side === "left" ? leftStore : rightStore;
      activeStore.updateAnalysis({
        focusSnapshots: (activeStore.analysis.focusSnapshots || []).map((snapshot) =>
          snapshot.id === snapshotId ? { ...snapshot, note } : snapshot
        ),
      });
    },
    [leftStore, rightStore]
  );

  const clearAllFocusSnapshots = useCallback(() => {
    if (!focusSnapshotStats.total) {
      return;
    }
    const message = t("Clear all {count} screenshot notes? This cannot be undone.", {
      count: focusSnapshotStats.total,
    });
    if (!window.confirm(message)) {
      return;
    }
    leftStore.updateAnalysis({ focusSnapshots: [] });
    rightStore.updateAnalysis({ focusSnapshots: [] });
    setFocusArtifactExpandedId(null);
    setFocusArtifactEditingId(null);
  }, [focusSnapshotStats.total, leftStore, rightStore]);

  const downloadFocusSnapshot = useCallback((snapshot: FocusSnapshot) => {
    const link = document.createElement("a");
    link.href = snapshot.imageDataUrl;
    link.download = toDownloadFileName(snapshot);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  /**
   * Crop a rectangle out of the current frame and hand it to the composer.
   *
   * It takes the rectangle it is given rather than reading the focus window's
   * own crop, so a box dragged over the video goes straight to a note. The
   * focus window is one caller of this, not the road to it.
   */
  const captureAreaSnapshot = useCallback(
    async (
      captureSide: ComparisonSide,
      areaRect: FocusAreaRect,
      previewImageDataUrl = ""
    ): Promise<{ ok: boolean; error?: string }> => {
      const isLeft = captureSide === "left";
      const activeStore = isLeft ? leftStore : rightStore;
      const activePlayback = isLeft ? leftPlayback : rightPlayback;
      const sourceVideo = isLeft ? playerVideoLeft : playerVideoRight;
      const sourceVideoElement = isLeft ? leftVideoRef.current : rightVideoRef.current;
      const sourceDrawing = isLeft ? leftDrawing : rightDrawing;
      const sourceOverlay = isLeft ? leftOverlayDimensions : rightOverlayDimensions;

      if (!sourceVideo || !sourceVideoElement) {
        return { ok: false, error: t("Source video is not available.") };
      }

      let imageDataUrl = "";
      let sourceImageMeta: FocusSnapshot["sourceImageMeta"] | undefined;
      const { width: sourceWidth, height: sourceHeight } = getSafeSourceDimensions(
        sourceVideo,
        sourceVideoElement,
        activePlayback.dimensions
      );
      const sourceCrop = buildSourceCropRect(areaRect, sourceWidth, sourceHeight);

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
          throw new Error(t("Could not create a source canvas."));
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

      // Prefer the composited frame so the screenshot preserves any lines,
      // angles or circles the coach has drawn over the swing.
      const annotatedImage = captureAnalysisFrame(
        { video: sourceVideoElement, objects: sourceDrawing.objects, overlay: sourceOverlay },
        sourceCrop.sourceCropRect
      );
      if (isDataUrl(annotatedImage)) {
        imageDataUrl = annotatedImage;
        sourceImageMeta = createSourceImageMeta(
          sourceCrop.sourceWidth,
          sourceCrop.sourceHeight,
          sourceCrop.sourceCropRect,
          true
        );
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
        return { ok: false, error: t("Crop image data is not available.") };
      }

      const safeTime = Number.isFinite(activePlayback.currentTime)
        ? activePlayback.currentTime
        : 0;
      const safeFps = sourceVideo.fps || activePlayback.frameRate || FRAME_RATE_DEFAULT;
      const safeFrame = Math.max(0, Math.round(safeTime * safeFps));

      const snapshot: FocusSnapshot = {
        id: createId(`focus-${captureSide}`),
        playerId: resolvedPlayerId,
        analysisId: activeStore.analysis.id,
        title: t("Focus snapshot"),
        note: "",
        captureKind: "area",
        side: captureSide,
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
        cropRect: { ...areaRect },
        imageDataUrl,
        createdAt: new Date().toISOString(),
      };

      // The crop lifts out of the frame it was taken from and lands in a
      // composer beside it. Nothing is written to the analysis until Save.
      stageSnapshotDraft(
        snapshot,
        { ...areaRect },
        sourceCrop.sourceCropRect.width / Math.max(1, sourceCrop.sourceCropRect.height)
      );

      return { ok: true };
    },
    [
      leftPlayback,
      leftDrawing,
      leftOverlayDimensions,
      leftStore,
      playerVideoLeft,
      playerVideoRight,
      rightPlayback,
      rightDrawing,
      rightOverlayDimensions,
      rightStore,
      resolvedPlayerId,
      stageSnapshotDraft,
    ]
  );

  const captureFullFrame = useCallback(() => {
    const side = effectiveActiveSide;
    const video = side === "left" ? playerVideoLeft : playerVideoRight;
    const playback = side === "left" ? leftPlayback : rightPlayback;
    const store = side === "left" ? leftStore : rightStore;
    const drawing = side === "left" ? leftDrawing : rightDrawing;
    const videoElement = side === "left" ? leftVideoRef.current : rightVideoRef.current;
    const overlay = side === "left" ? leftOverlayDimensions : rightOverlayDimensions;
    if (!video || !videoElement) return;
    const imageDataUrl = captureAnalysisFrame({ video: videoElement, objects: drawing.objects, overlay });
    if (!imageDataUrl) return;
    const safeTime = Number.isFinite(playback.currentTime) ? playback.currentTime : 0;
    const safeFps = video.fps || playback.frameRate || FRAME_RATE_DEFAULT;
    const width = videoElement.videoWidth || video.width || 1;
    const height = videoElement.videoHeight || video.height || 1;
    const snapshot: FocusSnapshot = {
      id: createId(`frame-${side}`),
      playerId: resolvedPlayerId,
      analysisId: store.analysis.id,
      title: t("Frame capture"),
      note: "",
      captureKind: "frame",
      side,
      sourceVideoId: video.id,
      sourceVideoTitle: video.title,
      sourceVideoMeta: { fps: video.fps, duration: video.duration, width: video.width, height: video.height },
      sourceImageMeta: createSourceImageMeta(width, height, { x: 0, y: 0, width, height }, true),
      currentTime: safeTime,
      currentFrame: Math.max(0, Math.round(safeTime * safeFps)),
      cropRect: { x: 0, y: 0, width: 1, height: 1 },
      imageDataUrl,
      createdAt: new Date().toISOString(),
    };
    // A whole frame gets the shutter as well as the lift -- the flash says the
    // picture was taken, the lift says where it went.
    playCaptureAnimation(side);
    stageSnapshotDraft(snapshot, null, width / Math.max(1, height));
  }, [
    effectiveActiveSide,
    leftDrawing,
    leftOverlayDimensions,
    leftPlayback,
    leftStore,
    playerVideoLeft,
    playerVideoRight,
    playCaptureAnimation,
    resolvedPlayerId,
    rightDrawing,
    rightOverlayDimensions,
    rightPlayback,
    rightStore,
    stageSnapshotDraft,
  ]);

  /**
   * One capture, whichever shape it takes.
   *
   * A box drawn over the video is the coach saying "this part"; without one
   * they mean the whole picture. The box survives the capture, so the same
   * region can be taken again at address and at impact.
   */
  const captureSnapshot = useCallback(() => {
    if (captureBox) {
      void captureAreaSnapshot(captureBox.side, captureBox.rect);
      return;
    }
    captureFullFrame();
  }, [captureAreaSnapshot, captureBox, captureFullFrame]);

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

  // A box is drawn round something in a particular picture. Swap the clip out
  // from under it and it is a rectangle over someone else's swing.
  useEffect(() => {
    setCaptureBox((current) => {
      if (!current) return current;
      const stillLoaded = current.side === "left" ? playerVideoLeft : playerVideoRight;
      return stillLoaded ? current : null;
    });
  }, [playerVideoLeft, playerVideoRight]);

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

  useKeyboardShortcuts({
    // The lab owns space and the arrows while it is open.
    enabled: !motionLabOpen,
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
    onCapture: workspaceHasVideo && !isPlayerVariant ? captureSnapshot : undefined,
    onSave: workspaceHasVideo ? () => void handleManualSave() : undefined,
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
      setSaveMessage(t("Add or record a clip before saving."));
      return null;
    }

    if (!saveableSides.length) {
      setSaveStatus("error");
      setSaveMessage(t("Save needs an uploaded or recorded video."));
      return null;
    }

    if (!savedVideoStore || !persistenceLayer.videoStore) {
      setSaveStatus("error");
      setSaveMessage(t("Device video storage is unavailable in this browser."));
      return null;
    }

    // Every saved video belongs to a player. Opened without one, ask now.
    let owner: VideoWorkspacePlayerChoice | null = playerId
      ? { playerId, playerName: resolvedPlayerName }
      : null;
    if (!owner) {
      if (!onChoosePlayerForSave) {
        setSaveStatus("error");
        setSaveMessage(t("Open this video from a player profile to save it."));
        return null;
      }
      owner = await onChoosePlayerForSave();
      if (!owner) {
        setSaveStatus("idle");
        setSaveMessage(t("Save cancelled. Pick a player to save this video."));
        return null;
      }
    }

    setSaveStatus("saving");
    setSaveMessage(options.archiveToMyLibrary ? t("Saving permanently to My Library...") : t("Saving..."));
    setCloudUploadFailure(null);

    try {
      const [leftSaved, rightSaved] = await Promise.all([
        leftStore.saveNow(),
        rightStore.saveNow(),
      ]);

      if (!leftSaved || !rightSaved) {
        throw new Error(t("One side could not be saved."));
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
            t("{side} video source is missing from recovery storage.", { side: getSideTitle(side) })
          );
        }

        const item = await savedVideoStore.saveItem({
          savedVideoId: nextSavedVideoIds[side],
          playerId: owner.playerId,
          lessonId,
          title: playerVideo.title,
          sourceSide: side,
          sourceVideo: { ...playerVideo, playerId: owner.playerId },
          sourceBlob: transient.blob,
          analysisSnapshot: {
            ...(analysisStore.analysis as VideoAnalysis),
            playerId: owner.playerId,
          },
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
          t("No active video was available to save.")
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
            ? t("Saved permanently to My Library.")
            : t("Saved {length} videos permanently to My Library.", { length: savedItems.length })
          : options.archiveToMyLibrary
            ? t("Saved safely on this device. Reconnect My Library when available.")
          : savedItems.length === 1
            ? t("Saved safely on this device. Preparing Clarity Cloud.")
            : t("Saved {length} videos safely on this device. Preparing Clarity Cloud.", { length: savedItems.length })
      );
      setSaveStatus("saved");
      const navigation = buildNavigationContext(reason);
      return {
        ...navigation,
        playerId: owner.playerId,
        playerName: owner.playerName,
        hasPlayerContext: true,
        savedVideoId: savedItems[0]?.savedVideoId || navigation.savedVideoId,
        savedItems,
        reason,
      } satisfies VideoWorkspaceSaveResult;
    } catch (error) {
      setSaveStatus("error");
      const message =
        error instanceof SavedVideoLibraryError
          ? error.message
          : t("Device save failed. Workspace was kept intact.");
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
    onChoosePlayerForSave,
    onSavedVideoLibraryChange,
    persistenceLayer.videoStore,
    persistenceLayer.workspaceAdapter,
    playerId,
    playerVideoLeft,
    playerVideoRight,
    resolvedPlayerId,
    resolvedPlayerName,
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
      // The reset leaves an empty workspace behind -- the upload screen. The
      // coach pauses on it long enough to read the confirmation, because their
      // console stays put either way. The player is being taken back to their
      // library, so pausing there is a flash of a screen they did not ask for:
      // land them on the library and let the new tile be the confirmation.
      if (!isPlayerVariant) await briefSuccessDelay();
      await onLocalSaveComplete?.(result);
    },
    [isPlayerVariant, onLocalSaveComplete, resetWorkspaceAfterDurableSave]
  );

  const handleManualSave = useCallback(async () => {
    const result = await performDurableSave("save");
    if (!result) return;
    await completeSuccessfulSave(
      result,
      isPlayerVariant
        ? t("Saved to this device. Find it under Your videos.")
        : t("Saved safely. Returning to Player Profile.")
    );
  }, [completeSuccessfulSave, isPlayerVariant, performDurableSave]);

  const handleMyLibrarySave = useCallback(async () => {
    const result = await performDurableSave("my-library-save", { archiveToMyLibrary: true });
    if (!result) return;
    await completeSuccessfulSave(result, t("Saved permanently to My Library."));
  }, [completeSuccessfulSave, performDurableSave]);

  const handleSaveAndSend = useCallback(async () => {
    const result = await performDurableSave("save");
    if (!result) return;

    if (!onSaveAndSend) {
      setSaveStatus("error");
      setSaveMessage(t("Transfer service unavailable."));
      setCloudUploadFailure(buildCloudUploadFailureFeedback(
        Object.assign(new Error(t("Transfer service unavailable.")), {
          code: "CLARITY_CLOUD_PROVIDER_FAILED",
        })
      ));
      return;
    }

    setSaveStatus("sending");
    setSaveMessage(
      isPlayerVariant ? t("Sending to your coach...") : t("Preparing Clarity Cloud transfer...")
    );
    setCloudUploadFailure(null);
    try {
      await onSaveAndSend(result);
      setCloudUploadFailure(null);
      await completeSuccessfulSave(
        result,
        isPlayerVariant
          ? t("Sending to your coach. Track it under Your videos.")
          : t("Uploading 0% in Player Profile.")
      );
    } catch (error) {
      setSaveStatus("error");
      const cloudFailure = buildCloudUploadFailureFeedback(error);
      const safeMessage =
        cloudFailure.stage === "Uploading"
          ? t("Cloud upload paused. Your local video is safe.")
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
    isPlayerVariant,
    onSaveAndSend,
    onSavedVideoLibraryChange,
    performDurableSave,
  ]);

  // The recording is always saved as a brand new library item. The source
  // video it was recorded over is never written to.
  const saveScreenRecording = useCallback(
    async (recording: AnalysisRecording) => {
      if (!savedVideoStore) {
        throw new Error(t("Device video storage is unavailable in this browser."));
      }
      const side = effectiveActiveSide;
      const analysisStore = side === "left" ? leftStore : rightStore;
      const sourceVideo = side === "left" ? playerVideoLeft : playerVideoRight;
      const createdAt = new Date().toISOString();
      const title = sourceVideo?.title ? `${sourceVideo.title} - commentary` : "Analysis commentary";
      const item = await savedVideoStore.saveItem({
        playerId: resolvedPlayerId,
        lessonId,
        title,
        sourceSide: side,
        sourceVideo: {
          id: `analysis-recording-${createId()}`,
          playerId: resolvedPlayerId,
          lessonId,
          sourceUrl: "",
          title: getRecordingFileName("analysis-recording", recording.mimeType),
          createdAt,
          duration: recording.durationMs / 1000,
          width: recording.width,
          height: recording.height,
        },
        sourceBlob: recording.blob,
        analysisSnapshot: analysisStore.analysis as VideoAnalysis,
        workspaceSnapshot: buildWorkspaceState(),
        thumbnailDataUrl: captureSideThumbnail(side),
      });
      onSavedVideoLibraryChange?.();
      setScreenRecordingStatus("idle");
      setScreenRecordingMessage(t("Saved \"{value}\" as a new video.", { value: item.title || title }));
    },
    [
      buildWorkspaceState,
      captureSideThumbnail,
      effectiveActiveSide,
      leftStore,
      lessonId,
      onSavedVideoLibraryChange,
      playerVideoLeft,
      playerVideoRight,
      resolvedPlayerId,
      rightStore,
      savedVideoStore,
    ]
  );

  const startScreenRecording = useCallback(async () => {
    if (analysisRecorderRef.current) return;
    const recorder = new AnalysisViewRecorder(() => recorderFrameRef.current);
    try {
      await recorder.start();
      analysisRecorderRef.current = recorder;
      setScreenRecordingStatus("recording");
      setScreenRecordingMessage(t("Recording this view with your commentary."));
    } catch (error) {
      setScreenRecordingStatus("error");
      setScreenRecordingMessage(
        error instanceof Error ? error.message : t("Could not start recording.")
      );
    }
  }, []);

  const stopScreenRecording = useCallback(async () => {
    const recorder = analysisRecorderRef.current;
    if (!recorder) return;
    setScreenRecordingStatus("saving");
    setScreenRecordingMessage(t("Saving recording..."));
    try {
      const recording = await recorder.stop();
      analysisRecorderRef.current = null;
      await saveScreenRecording(recording);
    } catch (error) {
      analysisRecorderRef.current = null;
      setScreenRecordingStatus("error");
      setScreenRecordingMessage(
        error instanceof Error ? error.message : t("Could not save the recording.")
      );
    }
  }, [saveScreenRecording]);

  useEffect(
    () => () => {
      analysisRecorderRef.current?.cancel();
      analysisRecorderRef.current = null;
    },
    []
  );

  const handleWorkspaceNoteCommit = useCallback(
    async (text: string) => {
      if (!onSaveNote) return false;
      return (await onSaveNote(text)) !== false;
    },
    [onSaveNote]
  );

  const toRectStyle = (rect: FocusAreaRect): React.CSSProperties => ({
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  });

  /**
   * Sit the composer beside the crop, on whichever side has the room.
   *
   * Beside and not over: the coach is writing about what is still on the frame
   * behind it, and a panel parked on top of the selection hides the thing the
   * note is about.
   */
  const toComposerAnchorStyle = (anchor: FocusAreaRect): React.CSSProperties => {
    const gapPercent = 2;
    const leftEdge = clamp(anchor.x, 0, 1) * 100;
    const rightEdge = clamp(anchor.x + anchor.width, 0, 1) * 100;
    const style: React.CSSProperties = {
      top: `${Math.min(clamp(anchor.y, 0, 1) * 100, 58)}%`,
    };
    if (rightEdge <= 58) {
      style.left = `${rightEdge + gapPercent}%`;
    } else {
      style.right = `${Math.min(100 - leftEdge + gapPercent, 72)}%`;
    }
    return style;
  };

  const renderSnapshotComposer = (draft: SnapshotDraft) => {
    const { snapshot, anchor, aspect, note } = draft;
    const safeAspect = clamp(aspect, 0.45, 3.2);
    const thumbWidth =
      safeAspect >= COMPOSER_THUMB_WIDTH / COMPOSER_THUMB_HEIGHT
        ? COMPOSER_THUMB_WIDTH
        : Math.round(COMPOSER_THUMB_HEIGHT * safeAspect);
    const thumbHeight = Math.round(thumbWidth / safeAspect);
    return (
      <div
        ref={composerRef}
        className={`snapshot-composer ${anchor ? "is-beside" : "is-corner"}`}
        style={anchor ? toComposerAnchorStyle(anchor) : undefined}
        role="group"
        aria-label={t("New screenshot note")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="snapshot-composer-dismiss"
          onClick={discardSnapshotDraft}
          aria-label={t("Discard this capture")}
          title={t("Discard this capture")}
        >
          ×
        </button>
        <img
          ref={composerThumbRef}
          className="snapshot-composer-thumb"
          src={snapshot.imageDataUrl}
          alt={t("Capture at {currentTime}", { currentTime: toFixedTime(snapshot.currentTime) })}
          style={{ width: thumbWidth, height: thumbHeight }}
        />
        <div className="snapshot-composer-meta">
          {toFixedTime(snapshot.currentTime)} • f {snapshot.currentFrame} •{" "}
          {getSideLabel(snapshot.side)}
        </div>
        <textarea
          ref={composerNoteRef}
          className="snapshot-composer-note"
          value={note}
          rows={3}
          placeholder={t("What are you looking at here?")}
          aria-label={t("Note for this capture")}
          onChange={(event) => {
            const nextNote = event.target.value;
            setSnapshotDraft((current) => (current ? { ...current, note: nextNote } : current));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              discardSnapshotDraft();
              return;
            }
            // Enter saves. A capture is often taken mid-swing with no time to
            // write anything -- Enter files it and the note can be added later
            // from the strip below. Shift+Enter is the newline for the times
            // the note does get written here and there.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commitSnapshotDraft();
            }
          }}
        />
        <button type="button" className="snapshot-composer-save" onClick={commitSnapshotDraft}>{t("Save")}</button>
      </div>
    );
  };

  /** The capture in flight, and the composer it is flying into. */
  const renderCaptureLayer = (side: ComparisonSide) => {
    const lift = captureLift && captureLift.side === side ? captureLift : null;
    const draft = snapshotDraft && snapshotDraft.snapshot.side === side ? snapshotDraft : null;
    if (!lift && !draft) {
      return null;
    }
    return (
      <>
        {lift ? (
          <React.Fragment key={lift.id}>
            {/* What the crop left behind, so an area capture reads as a piece
                being lifted out of the frame rather than a copy of it. */}
            {lift.isCutout ? (
              <div
                className="video-capture-cutout"
                style={toRectStyle(lift.rect)}
                aria-hidden="true"
              />
            ) : null}
            <img
              ref={captureLiftRef}
              className={`video-capture-lift ${lift.isCutout ? "is-cutout" : ""}`}
              src={lift.imageDataUrl}
              style={toRectStyle(lift.rect)}
              alt=""
              aria-hidden="true"
            />
          </React.Fragment>
        ) : null}
        {draft ? renderSnapshotComposer(draft) : null}
      </>
    );
  };

  const renderVideoCard = (
    side: ComparisonSide,
    overlayDimensions: { width: number; height: number },
    setOverlayDimensions: (dimensions: { width: number; height: number }) => void
  ) => {
    const isLeft = side === "left";
    const playerVideo = isLeft ? playerVideoLeft : playerVideoRight;
    const playback = isLeft ? leftPlayback : rightPlayback;
    const drawingState = isLeft ? leftDrawing : rightDrawing;
    const timelineState = isLeft ? leftTimelineState : rightTimelineState;
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
        aria-label={t("Upload {sideTitle} clip", { sideTitle: sideTitle.toLowerCase() })}
      >
        <span className="video-upload-icon" aria-hidden="true">
          <IconUpload />
        </span>
        <span className="video-upload-title">
          {primary ? t("Upload a video") : t("Upload {sideTitle} clip", { sideTitle: sideTitle.toLowerCase() })}
        </span>
        <span className="video-upload-copy">{t("Drag and drop or click to choose a file")}</span>
        {intakeError ? (
          <span className="video-upload-error" role="alert">
            {intakeError}
          </span>
        ) : null}
      </button>
    );

    /**
     * The stage with no picture in it yet.
     *
     * Everything it can say is a fact about the coach's one saved camera --
     * not chosen, not connected, connecting, ready. There is deliberately no
     * source picker here: the camera was chosen once in Video Settings, and
     * the only state that offers a way out points back there.
     */
    const renderCaptureStage = () => {
      const status = liveRecording?.side === side ? liveRecording.status : null;
      const isConnecting = status === "connecting";
      const isPending = status === "processing";
      const needsSetup = !preferredCamera;
      // Only believe "not connected" when the device list is actually saying
      // something. Safari blanks every device id and label until the page has
      // been granted camera access, so an empty-looking list is usually a
      // permission state, not an absent camera -- and treating it as absent is
      // what greyed out Record for a phone sitting there plugged in. When the
      // list has nothing to tell us we stay optimistic and let the attempt
      // decide, which is safe because every attempt is pinned to the saved id.
      const deviceListIsInformative = cameraDeviceList.labelsAvailable;
      const cameraMissing = !needsSetup && deviceListIsInformative && !resolvedCamera;
      const canConnect = cameraDeviceList.supported && !needsSetup && !isConnecting && !isPending;
      const hasLibraryChoice = Boolean(savedVideoStore);
      const openIntakeGroup = intakeGroup?.side === side ? intakeGroup.kind : null;
      // An attempt that just failed outranks the resting "Camera not connected"
      // -- it names which camera and why, and it is the only sign that the
      // button was pressed at all.
      const attemptError = status === "error" ? liveRecording?.error || "" : "";
      // Only colour the message as a problem when it is reporting one. A stale
      // error behind a "choose a camera" or "connecting" message is not.
      const isWarning =
        !isConnecting && !isPending && (cameraMissing || Boolean(attemptError));
      const message = needsSetup
        ? t("Choose a recording camera in Video Settings")
        : isConnecting
          ? t("Connecting…")
          : isPending
            ? t("Processing…")
            : attemptError || (cameraMissing ? t("Camera not connected") : t("Ready to record"));

      return (
        <div
          className={`comparison-video-panel is-capture-stage ${isActive ? "is-active" : ""}`}
          onMouseDown={() => setActiveSideInCompare(side)}
        >
          <div
            className={`video-capture-stage is-${recordingOrientation}${
              dragTargetSide === side ? " is-dragging" : ""
            }`}
            onDragEnter={(event) => handleDropZoneDrag(side, event)}
            onDragOver={(event) => handleDropZoneDrag(side, event)}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDragTargetSide((current) => (current === side ? null : current));
            }}
            onDrop={(event) => void handleDropUpload(side, event)}
          >
            <p
              className={`video-capture-message${isWarning ? " is-warning" : ""}`}
              aria-live="polite"
            >
              {message}
            </p>
            {intakeError ? (
              <span className="video-upload-error" role="alert">
                {intakeError}
              </span>
            ) : null}
          </div>

          {/* Two ways in: bring a clip that already exists (Upload), or bring
              a camera up (Connect). Each opens its own short row of choices;
              where a group has only one choice the button just does it. */}
          <div className="video-intake-actions">
            <button
              type="button"
              className={`upload-button${openIntakeGroup === "upload" ? " is-open" : ""}`}
              aria-expanded={hasLibraryChoice ? openIntakeGroup === "upload" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (hasLibraryChoice) {
                  toggleIntakeGroup(side, "upload");
                } else {
                  openUpload(side);
                }
              }}
            >
              <IconUpload />{t("Upload")}</button>
            {/* Connect is deliberately not gated on the camera resolving: it
                is the way to prod a camera the device list has not admitted
                to yet -- a sleeping Continuity Camera iPhone, most often. */}
            <button
              type="button"
              className={`upload-button${openIntakeGroup === "connect" ? " is-open" : ""}`}
              aria-expanded={playerId ? openIntakeGroup === "connect" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (playerId) {
                  toggleIntakeGroup(side, "connect");
                } else {
                  void connectPreferredCamera(side);
                }
              }}
              disabled={!playerId && !canConnect}
            >
              <IconCamera />{t("Connect")}</button>
          </div>
          {openIntakeGroup === "upload" ? (
            <div className="video-intake-actions video-intake-choices">
              {/* Importing a clip still has to work by click as well as by a
                  drop on the stage. */}
              <button
                type="button"
                className="upload-button is-subtle"
                onClick={(event) => {
                  event.stopPropagation();
                  setIntakeGroup(null);
                  openUpload(side);
                }}
              >
                <IconUpload />{t("From this device")}</button>
              {/* A video already saved -- on this device or in Clarity Cloud --
                  onto this side, without leaving the workspace. */}
              <button
                type="button"
                className="upload-button is-subtle"
                onClick={(event) => {
                  event.stopPropagation();
                  setIntakeGroup(null);
                  closeLiveRecording();
                  setLibrarySide(side);
                }}
              >
                <IconLibrary />{t("From library")}</button>
            </div>
          ) : null}
          {openIntakeGroup === "connect" ? (
            <div className="video-intake-actions video-intake-choices">
              {/* The saved camera opens as a live preview; Record is there. */}
              <button
                type="button"
                className="upload-button is-subtle"
                onClick={(event) => {
                  event.stopPropagation();
                  setIntakeGroup(null);
                  void connectPreferredCamera(side);
                }}
                disabled={!canConnect}
              >
                <IconCamera />{t("Camera")}</button>
              {/* The cameras on the bay's own computer, driven from here. */}
              <button
                type="button"
                className="upload-button is-subtle"
                onClick={(event) => {
                  event.stopPropagation();
                  setIntakeGroup(null);
                  closeLiveRecording();
                  setRemoteSide(side);
                }}
              >
                <IconCamera />Clarity Terminal</button>
            </div>
          ) : null}

          <div className="video-intake-actions">
            {/* The only route into Video Settings while the workspace is
                empty -- the action bar's gear arrives with a clip. It is one
                link, not a wizard: changing camera is a deliberate trip to
                the place that owns the setting. */}
            <button
              type="button"
              className="upload-button is-subtle"
              onClick={(event) => {
                event.stopPropagation();
                setSettingsOpen(true);
              }}
            >
              <IconSettings />{t("Video Settings")}</button>
            {status ? (
              <button
                type="button"
                className="video-tool-btn is-subtle"
                onClick={(event) => {
                  event.stopPropagation();
                  closeLiveRecording();
                }}
              >{t("Cancel")}</button>
            ) : null}
          </div>
        </div>
      );
    };

    // The Clarity Terminal panel takes the side over until the take lands or
    // the coach closes it. It needs a player: a take is filed under one the
    // moment Record is pressed.
    if (librarySide === side && savedVideoStore) {
      return (
        <div
          className={`comparison-video-panel ${isActive ? "is-active" : ""}`}
          onMouseDown={() => setActiveSideInCompare(side)}
        >
          <LibraryClipPanel
            playerName={playerId ? resolvedPlayerName : undefined}
            listThisPlayer={listThisPlayersLibrary}
            listUnassigned={listUnassignedLibrary}
            players={libraryPlayers}
            listPlayer={listLibraryForSide}
            onPick={loadLibraryClipIntoSide}
            onClose={() => setLibrarySide(null)}
          />
        </div>
      );
    }

    if (remoteSide === side && playerId) {
      return (
        <div
          className={`comparison-video-panel ${isActive ? "is-active" : ""}`}
          onMouseDown={() => setActiveSideInCompare(side)}
        >
          <RemoteCameraPanel
            player={{ playerId, playerName: resolvedPlayerName, lessonId }}
            onTakesReady={loadTerminalTakes}
            onClose={() => setRemoteSide(null)}
          />
        </div>
      );
    }

    // Recording intentionally uses the same canvas component and shell as a
    // loaded clip. Once capture finishes, `loadClipFileForSide` swaps this
    // preview for the recording's normal playback video without a second UI.
    if (liveRecording?.side === side && liveStream) {
      const isBusy =
        liveRecording.status === "recording" || liveRecording.status === "processing";
      return (
        <div
          className={`comparison-video-panel is-live-recording ${isActive ? "is-active" : ""}`}
          onMouseDown={() => setActiveSideInCompare(side)}
        >
          <div className="video-canvas-shell">
            {/* Keyed apart from the playback canvas below. Without it React
                reuses this very <video> element when the recording finishes,
                and an element still holding a MediaStream ignores the `src`
                it is then given -- a black frame that never loads the clip. */}
            <VideoCanvas
              key="live-camera"
              sourceUrl={null}
              liveStream={liveStream}
              videoRef={livePreviewRef}
              onLoadMetadata={() => undefined}
              objects={[]}
              draftObject={null}
              activeObjectId={null}
              onPointerDown={() => undefined}
              onPointerMove={() => undefined}
              onPointerUp={() => undefined}
              overlayDimensions={overlayDimensions}
              onDimensionsChange={setOverlayDimensions}
            />
            {/* Record, Stop, and a way out. No camera picker: the source was
                settled in Video Settings before the coach got here. */}
            <div className="live-recording-toolbar">
              {liveRecording.status === "recording" ? (
                <button
                  type="button"
                  className="upload-button video-record-stop"
                  onClick={stopLiveRecording}
                >{t("Stop")}</button>
              ) : (
                <button
                  type="button"
                  className="upload-button video-record-button"
                  onClick={() => void startLiveRecording(side)}
                  disabled={liveRecording.status === "processing"}
                >
                  <IconRecord />{t("Record")}</button>
              )}
              <span className={`live-recording-status is-${liveRecording.status}`}>
                {liveRecording.status === "recording"
                  ? t("Recording")
                  : liveRecording.status === "processing"
                    ? t("Processing")
                    : liveRecording.error || t("Ready to record")}
              </span>
              {/* The preview shows the stream as it really is, so when the
                  camera hands back the other orientation the coach is told
                  rather than shown a portrait crop the file will not have. */}
              {orientationMismatch && liveRecording.status !== "processing" ? (
                <span className="live-recording-status is-error">{t("This camera is only offering")}{" "}{recordingOrientation === "portrait" ? "landscape" : "portrait"}.
                </span>
              ) : null}
              <button
                type="button"
                className="video-tool-btn is-subtle"
                onClick={closeLiveRecording}
                disabled={isBusy}
                aria-label={t("Close live recording")}
              >{t("Close")}</button>
            </div>
          </div>
        </div>
      );
    }

    // A session with no stream yet: connecting, or a saved camera that is not
    // plugged in. It reuses the empty stage rather than showing a black
    // VideoCanvas, so the workspace never looks like a camera that is on.
    if (liveRecording?.side === side) {
      return renderCaptureStage();
    }

    if (!playerVideo) {
      /* A player is always on their own phone -- tapping the card opens iOS's
         native camera/photo sheet, so there is nothing for a Record button
         here to do that the card does not already do. Coaches get the capture
         stage instead: they are recording from a mounted phone or an attached
         camera, which has no native picker to fall back on. */
      if (isPlayerVariant) {
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
            {renderUploadDropZone()}
          </div>
        );
      }

      return renderCaptureStage();
    }

    return (
      <div
        className={`comparison-video-panel ${isActive ? "is-active" : ""} ${
          isFocusSourceHovered ? "is-focus-source" : ""
        }`}
        onMouseDown={() => setActiveSideInCompare(side)}
      >
        {/* No header row over the picture, in either mode.

            Everything it held has a home that does not depend on which mode
            you are in. Play is the action bar, and the picture itself.
            Record, Replace and Clear are the settings sheet, which names the
            side it is about to act on and follows whichever panel you last
            touched. Which side this panel is reads off the timeline caption
            under it ("L Left timeline"), and which one is active reads off
            the panel's own highlight.

            Compare mode used to keep the row on the grounds that two videos
            at once is when "which side, which clip" is worth a permanent
            label. But the timeline caption was already saying it, and the
            four buttons next to it were not labels -- they were the console
            coming back the moment you opened a second video. */}
        <div className="video-canvas-shell">
          <VideoCanvas
            key="clip-playback"
            sourceUrl={mountedSource}
            videoRef={isLeft ? leftVideoRef : rightVideoRef}
            onLoadMetadata={() => onSourceLoad(side)}
            objects={drawingState.objects}
            draftObject={drawingState.draftObject}
            activeObjectId={drawingState.activeObjectId}
            hoverGrabbable={drawingState.hoverGrabbable}
            captureBox={captureBox && captureBox.side === side ? captureBox.rect : null}
            draggedObjectId={drawingState.isObjectDragging ? drawingState.draggingObjectId : null}
            onTrashDrop={(objectId) => {
              if (!drawingState.draggingObjectId || drawingState.draggingObjectId !== objectId) {
                return false;
              }
              drawingState.cancel();
              drawingState.deleteByIds([objectId]);
              return true;
            }}
            onPointerDown={(point, meta) => {
              handleCanvasPointerDown(side, point, meta);
            }}
            onPointerMove={(point) => {
              handleCanvasPointerMove(side, point);
            }}
            onPointerUp={(point) => {
              handleCanvasPointerUp(side, point);
            }}
            onPointerHover={(point) => {
              handleCanvasPointerHover(side, point);
            }}
            overlayDimensions={overlayDimensions}
            onDimensionsChange={setOverlayDimensions}
            onTogglePlay={() => {
              setActiveSideInCompare(side);
              playPauseSide(side);
            }}
            underlay={
              showAnalysisRail ? (
                <LivePoseLayer
                  videoRef={isLeft ? leftVideoRef : rightVideoRef}
                  showMarkers={showBodyMarkers}
                  showGroundForce={showGroundForce}
                  dimensions={overlayDimensions}
                  widgetHost={forceHosts[side]}
                  onCloseGroundForce={() => setShowGroundForce(false)}
                />
              ) : null
            }
          />
          {hasSelectionDraft ? <div className="focus-selection-overlay" style={draftStyle || undefined} /> : null}
          {captureAnimation?.side === side ? (
            <div className="video-capture-flash" key={captureAnimation.id} aria-hidden="true">
              <span />
            </div>
          ) : null}
          {renderCaptureLayer(side)}
          <PlayerToolRailToggle
            open={toolRailOpen}
            onToggle={() => setToolRailOpen((previous) => !previous)}
          />
          <PlayerToolRail
            open={toolRailOpen}
            selectedTool={drawingState.selectedTool}
            onToolChange={updateActiveDrawingTool}
            onUndo={drawingState.undo}
            canUndo={drawingState.canUndo}
            onClear={clearActiveDrawing}
            canClear={drawingState.objects.length > 0}
            onFocusOpen={
              isPlayerVariant ? undefined : () => setFocusPaletteOpen((previous) => !previous)
            }
            onCapture={isPlayerVariant ? undefined : captureSnapshot}
            captureTooltip={
              captureBox ? t("Screenshot the box (Space)") : t("Screenshot the frame (Space)")
            }
          />
          {showAnalysisRail ? (
            <AnalysisRail
              onUpload={() => openUpload(side)}
              onOpenLibrary={
                savedVideoStore
                  ? () => {
                      clearFocusSelection();
                      setLibrarySide(side);
                    }
                  : undefined
              }
              onOpen3D={MOTION_LAB_AVAILABLE ? () => void openMotionLab() : undefined}
              motionLabOpen={motionLabOpen}
              motionLabDisabled={saveBusy}
              showMarkers={showBodyMarkers}
              onToggleMarkers={() => setShowBodyMarkers((previous) => !previous)}
              showGroundForce={showGroundForce}
              onToggleGroundForce={() => setShowGroundForce((previous) => !previous)}
              onSnapPhases={swingPhasesEnabled ? (isLeft ? leftPhases : rightPhases).snap : undefined}
              phaseState={(isLeft ? leftPhases : rightPhases).state}
            />
          ) : null}
          <div
            className="va-force-dock"
            ref={isLeft ? setLeftForceHost : setRightForceHost}
          />
        </div>
        <Timeline
          duration={Math.max(1, playback.duration || (isLeft ? leftCurrentDuration : rightCurrentDuration) || 0)}
          currentTime={playback.currentTime}
          zoom={timelineState.zoom}
          markers={markerMode}
          hoverMarker={hoverMarker}
          compact={modeIsCompare}
          showHeader={!isPlayerVariant}
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

  const saveBusy =
    saveStatus === "saving" || saveStatus === "sending" || saveStatus === "downloading";

  /**
   * Open the lab on the active clip.
   *
   * The workspace only holds the clip as an object URL (see loadClipFileForSide),
   * so the bytes are read back through it. That is a blob: URL over memory the
   * page already owns -- no copy, no network -- and it works the same for an
   * uploaded file, a restored one and a live recording, which is why this does
   * not go looking in the blob store for whichever of them it was.
   *
   * In compare mode the other panel's clip goes too, as a second angle: a
   * coach comparing face-on with down the line has both cameras of one swing
   * on screen, and the lab fuses them. If the two turn out not to be the same
   * swing, the lab says so and uses the active clip alone.
   */
  const cloudScope: VideoTransferScope = isPlayerVariant ? "player" : "coach";

  /** A saved video's bytes, from this device or, failing that, Clarity Cloud. */
  const readSavedVideo = useCallback(
    async (savedId: string): Promise<MotionLabSwing> => {
      if (!savedVideoStore) {
        throw new Error(t("Saved video library is unavailable in this browser."));
      }
      let item = await savedVideoStore.getItem(savedId);
      let blob = item ? await savedVideoStore.getBlob(savedId) : null;
      if (!blob) {
        item = await importSavedVideoFromClarityCloud(savedId, savedVideoStore, { scope: cloudScope });
        onSavedVideoLibraryChange?.();
        blob = await savedVideoStore.getBlob(item.savedVideoId);
      }
      if (!item || !blob) throw new Error(t("That video could not be loaded."));
      return {
        blob,
        name: item.title || item.source.originalFileName || t("Saved video"),
        id: item.savedVideoId,
      };
    },
    [cloudScope, onSavedVideoLibraryChange, savedVideoStore]
  );

  /**
   * Open the lab on the active clip, and bring its other angle with it.
   *
   * In compare mode the other panel's clip is the other angle: a coach
   * comparing face-on with down the line has both cameras of one swing on
   * screen. Otherwise it is the clip the library pairs with this one as the
   * same swing (see utils/sameSwingAngles), when there is one. If the two
   * turn out not to be the same swing, the lab says so, uses the active clip
   * alone, and the library stops pairing them.
   */
  const openMotionLab = useCallback(async () => {
    const side = effectiveActiveSide;
    const otherSide: ComparisonSide = side === "left" ? "right" : "left";
    const clip = side === "left" ? playerVideoLeft : playerVideoRight;
    const otherClip = modeIsCompare ? (side === "left" ? playerVideoRight : playerVideoLeft) : null;
    if (!clip) return;
    setMotionLabError(null);
    // The workspace holds each clip as an object URL (see loadClipFileForSide);
    // reading it back is a blob: URL over memory the page already owns.
    const read = async (source: NonNullable<typeof clip>, sourceSide: ComparisonSide): Promise<MotionLabSwing> => {
      const response = await fetch(source.sourceUrl);
      if (!response.ok) throw new Error(t("The clip could not be read ({status}).", { status: response.status }));
      const blob = await response.blob();
      return {
        blob,
        name: source.title || t("{side} clip", { side: getSideTitle(sourceSide) }),
        id: currentSavedVideoIds[sourceSide],
      };
    };
    try {
      const [swing, shownAngle] = await Promise.all([
        read(clip, side),
        otherClip ? read(otherClip, otherSide) : Promise.resolve(null),
      ]);
      let secondAngle = shownAngle;
      if (!secondAngle && swing.id && savedVideoStore) {
        try {
          const items = await savedVideoStore.listItemsForPlayer(clip.playerId);
          const partnerId = pairSavedVideoAngles(items).get(swing.id);
          if (partnerId) secondAngle = await readSavedVideo(partnerId);
        } catch {
          // The swing opens alone; the lab's picker can still add the angle.
        }
      }
      setMotionLabSwing(swing);
      setMotionLabSecondAngle(secondAngle);
      setMotionLabPlayerId(clip.playerId);
      setMotionLabOpen(true);
    } catch (error) {
      setMotionLabError(
        error instanceof Error ? error.message : t("The clip could not be read.")
      );
    }
  }, [
    currentSavedVideoIds,
    effectiveActiveSide,
    modeIsCompare,
    playerVideoLeft,
    playerVideoRight,
    readSavedVideo,
    savedVideoStore,
  ]);

  /**
   * The player's library, as the lab's second-angle picker sees it: every
   * saved video on this device, and every one in Clarity Cloud that is not,
   * with the clip the library pairs with the swing first.
   */
  /**
   * Saved videos as a picker lists them: every one on this device, and every
   * one in Clarity Cloud that is not, for the given owner ids (one person can
   * be filed under several). The clip the library pairs with `anchorId` (the
   * clip already open) comes first, marked as the same swing; clips from this
   * lesson are marked as likely too. `exclude` leaves out clips already on
   * screen. Shared by the "From library" panel and the 3D second-angle picker.
   */
  const listPlayerLibrary = useCallback(
    async (ownerIds: readonly string[], anchorId: string | undefined, exclude: readonly string[]): Promise<LibraryClip[]> => {
      if (!savedVideoStore || !ownerIds.length) return [];
      const owners = new Set(ownerIds);
      const items = (await savedVideoStore.listItems()).filter((item) => owners.has(item.playerId));
      const partnerId = anchorId ? pairSavedVideoAngles(items).get(anchorId) : undefined;
      const skip = new Set(exclude);
      const isThisLesson = (id?: string) => Boolean(lessonId && id === lessonId);
      const clips: (LibraryClip & { at: string })[] = items
        .filter((item) => !skip.has(item.savedVideoId))
        .map((item) => {
          const at = item.source.recordedAt || item.capturedAt || item.createdAt;
          const sameSwing = item.savedVideoId === partnerId;
          return {
            id: item.savedVideoId,
            title: item.title || item.source.originalFileName || t("Saved video"),
            detail: `${describeClipDate(at)} · ${
              item.local.status === "available" ? t("On this device") : t("Clarity Cloud")
            }`,
            thumbnail: item.thumbnailDataUrl,
            sameSwing,
            likely: sameSwing || isThisLesson(item.lessonId),
            at,
          };
        });
      const listed = new Set(items.map((item) => item.savedVideoId));
      try {
        const batches = await Promise.all(
          [...owners].map((ownerId) => listClarityCloudImportTransfers(cloudScope, ownerId))
        );
        for (const transfer of batches.flat()) {
          const id = transfer.savedVideoId || transfer.savedVideo?.savedVideoId;
          if (!id || skip.has(id) || listed.has(id)) continue;
          if (!transfer.savedVideo || !owners.has(transfer.savedVideo.playerId)) continue;
          listed.add(id);
          const at = transfer.savedVideo.createdAt;
          clips.push({
            id,
            title: transfer.savedVideo.title || t("Saved video"),
            detail: `${describeClipDate(at)} · ${t("Clarity Cloud")}`,
            likely: isThisLesson(transfer.savedVideo.lessonId),
            at,
          });
        }
      } catch {
        // Offline, or no cloud: the picker lists what is on this device.
      }
      return clips.sort(
        (a, b) =>
          Number(Boolean(b.sameSwing)) - Number(Boolean(a.sameSwing)) ||
          Number(Boolean(b.likely)) - Number(Boolean(a.likely)) ||
          b.at.localeCompare(a.at)
      );
    },
    [cloudScope, lessonId, savedVideoStore]
  );

  /** The player's library, as the lab's second-angle picker sees it. */
  const motionLabLibrary = useMemo<SecondAngleLibrary | undefined>(() => {
    if (!savedVideoStore || !motionLabPlayerId) return undefined;
    const swingId = motionLabSwing?.id;
    return {
      list: () => listPlayerLibrary([motionLabPlayerId], swingId, swingId ? [swingId] : []),
      load: readSavedVideo,
    };
  }, [listPlayerLibrary, motionLabPlayerId, motionLabSwing?.id, readSavedVideo, savedVideoStore]);

  /**
   * "From library" lists for the side it was opened on. The clip on the other
   * side anchors the same-swing match, and clips already on screen are left
   * out, whichever folder is being looked through.
   */
  const listLibraryForSide = useCallback(
    (ownerIds: readonly string[]) => {
      const side = librarySide ?? "left";
      const otherId = currentSavedVideoIds[side === "left" ? "right" : "left"];
      const onScreen = [currentSavedVideoIds.left, currentSavedVideoIds.right].filter(
        (id): id is string => Boolean(id)
      );
      return listPlayerLibrary(ownerIds, otherId, onScreen);
    },
    [currentSavedVideoIds, librarySide, listPlayerLibrary]
  );
  const listThisPlayersLibrary = useCallback(
    () => listLibraryForSide(playerId ? [playerId] : []),
    [listLibraryForSide, playerId]
  );
  const listUnassignedLibrary = useCallback(
    () => listLibraryForSide([LEGACY_UNASSIGNED_PLAYER_ID]),
    [listLibraryForSide]
  );

  const loadLibraryClipIntoSide = useCallback(
    async (id: string) => {
      const side = librarySide ?? "left";
      await restoreSavedVideo(id, { side, pair: false });
      setLibrarySide(null);
    },
    [librarySide, restoreSavedVideo]
  );

  /** The lab tried two library clips together: keep them paired, or stop pairing them. */
  const recordMotionLabVerdict = useCallback(
    (swingId: string, secondId: string, sameSwing: boolean) => {
      if (!savedVideoStore) return;
      const write = sameSwing ? linkSavedVideoAngles : refuseSavedVideoAngles;
      void write(savedVideoStore, swingId, secondId)
        .then(() => onSavedVideoLibraryChange?.())
        .catch(() => {
          // The pairing is a convenience; the 3D view itself is unaffected.
        });
    },
    [onSavedVideoLibraryChange, savedVideoStore]
  );

  const closeMotionLab = useCallback(() => {
    setMotionLabOpen(false);
    // Dropping the swing unmounts the lab's detector and revokes its URL;
    // reopening starts a fresh detection rather than showing a stale one.
    setMotionLabSwing(null);
    setMotionLabSecondAngle(null);
    setMotionLabPlayerId(null);
  }, []);

  return (
    <div className={`video-analysis-shell is-${variant}`}>
      <style>{videoAnalysisThemeCss}</style>
      {/* The player already knows whose swing this is and how they got here --
          the terminal's own bar says Videos and offers the way back. A title
          and a subtitle here spend the top of a phone screen restating it.
          The coach console keeps the back button always, but the full title
          block is only worth its space before there is a video to look at --
          once one loads, a compact strip replaces it so the picture gets the
          room instead. */}
      {isPlayerVariant ? null : workspaceHasVideo ? (
        <div className="video-analysis-header is-compact">
          <ToolButton
            icon={<IconBack />}
            label={t("Back")}
            tooltip={t("Back")}
            className="is-subtle video-header-back"
            disabled={!canGoBack}
            onClick={handleBackAction}
          />
          {playerName ? <span className="video-header-compact-title">{playerName}</span> : null}
        </div>
      ) : (
        <div className="video-analysis-header">
          <ToolButton
            icon={<IconBack />}
            label={t("Back")}
            tooltip={t("Back")}
            className="is-subtle video-header-back"
            disabled={!canGoBack}
            onClick={handleBackAction}
          />
          <div className="video-analysis-header-titles">
            <h1>{playerName ? t("{playerName} Video Analysis", { playerName }) : t("Clarity Golf Video Analysis")}</h1>
            <p className="subtitle">
              {resolvedPlayerName
                ? lessonTitle
                  ? t("{player} • {lesson} lesson context", { player: resolvedPlayerName, lesson: lessonTitle })
                  : t("{player} • Unlinked lesson context", { player: resolvedPlayerName })
                : t("Premium, protected, and reusable workspace foundation.")}
            </p>
          </div>
        </div>
      )}

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

      {motionLabError ? (
        <div className="focus-artifacts-warning" role="alert">{t("3D motion could not open: {motionLabError}", { motionLabError })}</div>
      ) : null}

      {motionLabOpen ? (
        <div className="va-motion-lab" role="dialog" aria-label={t("3D motion")}>
          <Suspense fallback={<div className="va-motion-lab-loading">{t("Loading 3D motion…")}</div>}>
            <MotionLabView
              swing={motionLabSwing}
              secondAngle={motionLabSecondAngle}
              library={motionLabLibrary}
              onSecondAngleVerdict={recordMotionLabVerdict}
              title={playerName || undefined}
              keysEnabled={!settingsOpen}
              onClose={closeMotionLab}
            />
          </Suspense>
        </div>
      ) : null}

      {cloudUploadFailure ? (
        <section className="cloud-upload-failure-row" role="alert" aria-live="assertive">
          <div className="cloud-upload-failure-copy">
            <span className="cloud-upload-failure-stage">
              {CLOUD_FAILURE_STAGE_LABELS[cloudUploadFailure.stage]}
            </span>
            <strong>{cloudUploadFailure.title}</strong>
            <span>{cloudUploadFailure.reason}</span>
          </div>
          <div className="cloud-upload-failure-actions">
            <button
              type="button"
              className="upload-button"
              onClick={() => void handleSaveAndSend()}
              disabled={saveBusy}
            >{t("Retry")}</button>
            {cloudUploadFailure.actionRequired && onOpenCloudSettings ? (
              <button
                type="button"
                className="upload-button"
                onClick={onOpenCloudSettings}
              >{t("Cloud settings")}</button>
            ) : null}
            <details className="cloud-upload-failure-diagnostics">
              <summary>{t("Advanced diagnostic")}</summary>
              <dl>
                <div>
                  <dt>{t("Safe error code")}</dt>
                  <dd>{cloudUploadFailure.safeErrorCode}</dd>
                </div>
                <div>
                  <dt>{t("Failed stage")}</dt>
                  <dd>{CLOUD_FAILURE_STAGE_LABELS[cloudUploadFailure.stage]}</dd>
                </div>
                {typeof cloudUploadFailure.retryable === "boolean" ? (
                  <div>
                    <dt>{t("Retryable")}</dt>
                    <dd>{cloudUploadFailure.retryable ? "true" : "false"}</dd>
                  </div>
                ) : null}
                {cloudUploadFailure.httpStatus ? (
                  <div>
                    <dt>{t("HTTP status")}</dt>
                    <dd>{cloudUploadFailure.httpStatus}</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          </div>
        </section>
      ) : null}

      {/* The always-on console bar is gone. Drawing tools live on the rail
          over the video, opened by the pencil in the frame's top-left corner
          (both rendered per panel above); everything else --
          compare mode, linked playback, sync, screen recording, the library
          save, diagnostics, swapping the active clip -- lives behind the
          settings gear on the action bar below. */}

      {/* The empty workspace is the capture stage and nothing else. Upload
          and Connect are inside the card -- there is no second row of buttons
          under it, because the card grew the ones it needs. */}
      {!workspaceHasVideo && !liveRecording ? (
        <section className="video-intake-panel" aria-label={t("Add video")}>
          {renderVideoCard(
            "left",
            leftOverlayDimensions,
            setLeftOverlayDimensions
          )}
        </section>
      ) : null}

      {workspaceHasVideo && (leftStore.persistenceError || rightStore.persistenceError) ? (
        <div className="focus-artifacts-warning" role="alert">
          {leftStore.persistenceError || rightStore.persistenceError}{" "}{t("Download and clear older Focus snapshots to free space.")}</div>
      ) : null}

      {workspaceHasVideo && needsCompareRotation ? (
        <section className="compare-rotate-gate" aria-live="polite">
          <span className="compare-rotate-gate-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="7" y="2.5" width="10" height="19" rx="2.4" />
              <path d="M3.6 15.4a9 9 0 0 0 3 4.2" strokeLinecap="round" />
              <path d="M20.4 8.6a9 9 0 0 0-3-4.2" strokeLinecap="round" />
              <path d="M3.4 12.2l.2 3.4 3.2-1.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20.6 11.8l-.2-3.4-3.2 1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <h2>{t("Rotate your phone")}</h2>
          <p>{t("Split View puts two swings side by side. Turn your phone sideways to compare them.")}</p>
          <button type="button" className="upload-button" onClick={() => updateMode("single")}>{t("Back to one video")}</button>
        </section>
      ) : null}

      {(workspaceHasVideo || liveRecording) && !needsCompareRotation ? (
        <div className={`comparison-layout ${modeIsCompare ? "is-compare" : "is-single"}`}>
          {modeIsCompare ? (
            <>
              {renderVideoCard(
                "left",
                leftOverlayDimensions,
                setLeftOverlayDimensions
              )}
              {renderVideoCard(
                "right",
                rightOverlayDimensions,
                setRightOverlayDimensions
              )}
            </>
          ) : (
            renderVideoCard("left", leftOverlayDimensions, setLeftOverlayDimensions)
          )}
        </div>
      ) : null}

      {workspaceHasVideo ? (
        <PlayerActionBar
          isPlaying={activePlayback.isPlaying}
          onTogglePlay={() => playPauseSide(effectiveActiveSide)}
          onStepFrame={(direction) => activePlayback.stepFrame(direction)}
          onSave={handleManualSave}
          onSend={isPlayerVariant ? () => void handleSaveAndSend() : undefined}
          canSend={isPlayerVariant && Boolean(onSaveAndSend)}
          busy={saveBusy}
          saving={saveStatus === "saving"}
          sending={saveStatus === "sending"}
          status={saveStatus === "idle" ? "" : saveMessage}
          statusTone={
            saveStatus === "error" ? "error" : saveStatus === "saved" ? "saved" : "idle"
          }
          settingsOpen={isPlayerVariant ? undefined : settingsOpen}
          onSettingsToggle={
            isPlayerVariant ? undefined : () => setSettingsOpen((previous) => !previous)
          }
        />
      ) : null}

      {/* Not gated on having a video: choosing the recording camera lives in
          here, and an empty workspace is exactly when a coach needs to. */}
      {!isPlayerVariant ? (
        <VideoSettingsSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          mode={comparisonMode}
          onModeChange={updateMode}
          linkedPlayback={linkedPlayback}
          onLinkedPlaybackToggle={() => setLinkedPlayback((previous) => !previous)}
          onSyncPlayheads={syncPlayheads}
          syncPlayheadsEnabled={Boolean(playerVideoLeft && playerVideoRight)}
          isRecordingScreen={screenRecordingStatus === "recording"}
          screenRecordingBusy={screenRecordingStatus === "saving"}
          screenRecordingMessage={screenRecordingMessage}
          onToggleScreenRecording={() =>
            screenRecordingStatus === "recording"
              ? void stopScreenRecording()
              : void startScreenRecording()
          }
          onMyLibrarySave={handleMyLibrarySave}
          saveBusy={saveBusy}
          showDiagnostics={showDiagnostics}
          onToggleDiagnostics={() => setShowDiagnostics((previous) => !previous)}
          activeSideLabel={getSideTitle(effectiveActiveSide)}
          hasActiveClip={Boolean(
            effectiveActiveSide === "left" ? playerVideoLeft : playerVideoRight
          )}
          onReplaceClip={() => openUpload(effectiveActiveSide)}
          onRecordReplacement={() => {
            setSettingsOpen(false);
            void startLiveRecording(effectiveActiveSide);
          }}
          onRecordWithTerminal={
            playerId
              ? () => {
                  setSettingsOpen(false);
                  closeLiveRecording();
                  setRemoteSide(effectiveActiveSide);
                }
              : undefined
          }
          onClearClip={() => {
            clearCurrentSide(effectiveActiveSide);
            setSettingsOpen(false);
          }}
          cameraDevices={cameraDeviceList.devices}
          preferredCamera={preferredCamera}
          resolvedCamera={resolvedCamera}
          cameraSupported={cameraDeviceList.supported}
          cameraLabelsAvailable={cameraDeviceList.labelsAvailable}
          cameraError={cameraDeviceList.error}
          onSelectCamera={handleSelectCamera}
          onRequestCameraLabels={() => void cameraDeviceList.requestLabels()}
          recordingOrientation={recordingOrientation}
          onSelectOrientation={handleSelectOrientation}
        />
      ) : null}

      {workspaceHasVideo && onSaveNote ? (
        <section className="video-note-panel" aria-label={t("Lesson note")}>
          <h2>{t("Lesson note")}</h2>
          <ClarityVoiceTextPanel
            fieldLabel={t("Lesson note")}
            placeholder={t("Type or dictate a note about this swing.")}
            onCommit={handleWorkspaceNoteCommit}
          />
        </section>
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
          onScreenshot={(previewDataUrl) =>
            focusAreaRect
              ? captureAreaSnapshot(focusWindowSide, focusAreaRect, previewDataUrl)
              : { ok: false, error: t("No valid focus crop selected.") }
          }
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

      {/* Screenshot notes belong to the saved analysis snapshot, so they stay
          attached to the review video. */}
      {workspaceHasVideo && !isPlayerVariant ? (
        <div className="focus-artifacts">
          <div className="focus-artifacts-title">
            <span className="focus-artifacts-title-text">{t("Screenshot notes")}<span>{focusSnapshotStats.total}</span>
            </span>
            {focusSnapshotStats.total ? (
              <button
                type="button"
                className="focus-artifacts-clear"
                onClick={clearAllFocusSnapshots}
              >{t("Clear all")}</button>
            ) : null}
          </div>
          {focusSnapshotStats.shouldWarn ? (
            <div className="focus-artifacts-warning">{t("You have {total} snapshots (~{estimatedMB} MB of local snapshot data). Consider downloading and clearing older shots.", { total: focusSnapshotStats.total, estimatedMB: focusSnapshotStats.estimatedMB.toFixed(1) })}</div>
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
                  aria-label={t("Toggle preview for {title}", { title: snapshot.title })}
                >
                  <img
                    src={snapshot.imageDataUrl}
                    className="focus-artifact-thumb"
                    alt={t("Focus snapshot {side}", { side: snapshot.side.toUpperCase() })}
                  />
                </button>
                <div className="focus-artifact-body">
                  <div className="focus-artifact-title">{snapshot.title}</div>
                  <div className="focus-artifact-meta">
                    {toFixedTime(snapshot.currentTime)} • f {snapshot.currentFrame} •{" "}
                    {getSideLabel(snapshot.side)}
                  </div>
                  {/* Filed, not still being written. The note reads as text
                      until somebody asks to change it -- a strip of open
                      textareas looks like a form nobody has finished. */}
                  {focusArtifactEditingId === snapshot.id ? (
                    <label className="focus-artifact-note">
                      <span>{t("Notes")}</span>
                      <textarea
                        value={snapshot.note || ""}
                        placeholder={t("Add a note about this position…")}
                        rows={2}
                        autoFocus
                        onChange={(event) =>
                          updateFocusSnapshotNote(snapshot.side, snapshot.id, event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            setFocusArtifactEditingId(null);
                          }
                        }}
                      />
                    </label>
                  ) : (
                    <p
                      className={`focus-artifact-note-text ${
                        snapshot.note ? "" : "is-empty"
                      }`}
                    >
                      {snapshot.note || t("No note")}
                    </p>
                  )}
                </div>
                <div className="focus-artifact-actions">
                  {focusArtifactEditingId === snapshot.id ? (
                    <>
                      <button
                        type="button"
                        className="focus-artifact-action"
                        onClick={() => setFocusArtifactEditingId(null)}
                      >{t("Done")}</button>
                      <a
                        className="focus-artifact-action"
                        href={snapshot.imageDataUrl}
                        download={toDownloadFileName(snapshot)}
                        onClick={(event) => {
                          event.preventDefault();
                          downloadFocusSnapshot(snapshot);
                        }}
                      >{t("Download")}</a>
                      <button
                        type="button"
                        className="focus-artifact-action"
                        onClick={() => renameFocusSnapshot(snapshot.side, snapshot.id)}
                        aria-label={t("Rename focus snapshot {title}", { title: snapshot.title })}
                        title={t("Rename snapshot")}
                      >{t("Rename")}</button>
                      <button
                        type="button"
                        className="focus-artifact-action focus-artifact-action--danger"
                        onClick={() => removeFocusSnapshot(snapshot.side, snapshot.id)}
                        aria-label={t("Delete focus snapshot {title}", { title: snapshot.title })}
                        title={t("Delete snapshot")}
                      >{t("Delete")}</button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="focus-artifact-edit"
                      onClick={() => setFocusArtifactEditingId(snapshot.id)}
                      aria-label={t("Edit note for {title}", { title: snapshot.title })}
                      title={t("Edit note")}
                    >
                      <IconEdit className="focus-artifact-edit-icon" />
                    </button>
                  )}
                </div>
              </article>
            ))
          ) : (
            <div className="focus-artifacts-empty">{t("Use the rail camera buttons or press Enter to capture.")}</div>
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

    </div>
  );
}
