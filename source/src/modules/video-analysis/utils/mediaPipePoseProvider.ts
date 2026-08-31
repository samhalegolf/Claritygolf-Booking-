import type { PoseFrame, PosePoint } from "./poseSwingDetector";

interface LandmarkLike {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

interface PoseResultLike {
  landmarks?: LandmarkLike[][];
}

interface PoseLandmarkerLike {
  detectForVideo(source: HTMLVideoElement, timestampMs: number): PoseResultLike;
  close?: () => void;
}

interface PoseLandmarkerFactoryLike {
  createFromOptions(
    fileset: unknown,
    options: Record<string, unknown>
  ): Promise<PoseLandmarkerLike>;
}

interface FilesetResolverLike {
  forVisionTasks(wasmRoot: string): Promise<unknown>;
}

interface MediaPipeVisionModule {
  FilesetResolver: FilesetResolverLike;
  PoseLandmarker: PoseLandmarkerFactoryLike;
}

export interface PoseProviderOptions {
  wasmRoot?: string;
  modelAssetPath?: string;
  minPoseDetectionConfidence?: number;
  minPosePresenceConfidence?: number;
  minTrackingConfidence?: number;
}

const DEFAULT_WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const DEFAULT_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";
const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

export class MediaPipePoseProvider {
  private landmarker: PoseLandmarkerLike | null = null;

  constructor(private readonly options: PoseProviderOptions = {}) {}

  async initialise() {
    if (this.landmarker) return;

    const module = (await import(/* @vite-ignore */ DEFAULT_MODULE_URL)) as MediaPipeVisionModule;
    const fileset = await module.FilesetResolver.forVisionTasks(
      this.options.wasmRoot || DEFAULT_WASM_ROOT
    );

    this.landmarker = await module.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: this.options.modelAssetPath || DEFAULT_MODEL,
      },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: this.options.minPoseDetectionConfidence ?? 0.55,
      minPosePresenceConfidence: this.options.minPosePresenceConfidence ?? 0.55,
      minTrackingConfidence: this.options.minTrackingConfidence ?? 0.55,
      outputSegmentationMasks: false,
    });
  }

  detect(video: HTMLVideoElement, timestampMs = performance.now()): PoseFrame | null {
    if (!this.landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const result = this.landmarker.detectForVideo(video, timestampMs);
    const landmarks = result.landmarks?.[0];
    if (!landmarks?.length) return null;

    return {
      timestampMs,
      landmarks: landmarks.map((point): PosePoint => ({
        x: point.x,
        y: point.y,
        z: point.z,
        visibility: point.visibility,
      })),
    };
  }

  close() {
    this.landmarker?.close?.();
    this.landmarker = null;
  }
}
