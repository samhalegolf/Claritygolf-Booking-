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
