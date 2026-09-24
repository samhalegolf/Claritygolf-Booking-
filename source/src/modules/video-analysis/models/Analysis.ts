import type { ComparisonSide } from "../utils/localPersistence";
import { TimelineMarker } from "./Timeline";
import { DrawingObject } from "./Drawing";
import type { FocusAreaRect } from "./Focus";

export interface AnalysisNote {
  id: string;
  time: number;
  text: string;
  createdAt: string;
}

export interface FocusSnapshotSourceImageMeta {
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

export interface FocusSnapshot {
  id: string;
  playerId: string;
  analysisId: string;
  title: string;
  /** A screenshot is a visual note; this is the coach's explanation beside it. */
  note?: string;
  captureKind?: "frame" | "area";
  side: ComparisonSide;
  sourceVideoId?: string;
  sourceVideoTitle?: string;
  sourceVideoMeta?: {
    fps?: number;
    duration?: number;
    width?: number;
    height?: number;
  };
  sourceImageMeta?: FocusSnapshotSourceImageMeta;
  currentTime: number;
  currentFrame: number;
  cropRect: FocusAreaRect;
  imageDataUrl: string;
  /**
   * The picture's copy in Clarity Cloud, once it has been uploaded. The data
   * URL never leaves the device; this id is what travels in the analysis file
   * so another device or the player's portal can fetch the picture.
   */
  imageFileId?: string;
  createdAt: string;
}

export interface VideoAnalysis {
  id: string;
  playerId: string;
  lessonId?: string;
  videoId: string;
  videoMeta?: {
    title?: string;
    duration?: number;
    fps?: number;
    width?: number;
    height?: number;
  };
  title?: string;
  drawings: DrawingObject[];
  markers: TimelineMarker[];
  notes: AnalysisNote[];
  focusSnapshots: FocusSnapshot[];
  focusViews: unknown[];
  narrationRefs: unknown[];
  createdAt: string;
  updatedAt: string;
}
