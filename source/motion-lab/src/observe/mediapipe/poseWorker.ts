/**
 * MediaPipe Pose, in a worker.
 *
 * Pose inference on a 1080p frame takes tens of milliseconds. Run on the main
 * thread across a few hundred frames that is several seconds of a frozen UI,
 * with no way to show progress or let the user cancel -- so it runs here, and
 * frames arrive as transferred ImageBitmaps.
 *
 * The bitmaps are TRANSFERRED, not copied: ownership moves to the worker and
 * the sender's handle is neutered. Each one is closed after use, because an
 * ImageBitmap holds GPU-backed memory that garbage collection will not
 * reclaim promptly, and a few hundred un-closed 1080p frames is enough to
 * exhaust it.
 */

import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

import type { RawLandmark } from "../observation";

export interface WorkerInitMessage {
  readonly type: "init";
  readonly wasmRoot: string;
  readonly modelAssetPath: string;
  readonly minPoseDetectionConfidence: number;
  readonly minPosePresenceConfidence: number;
  readonly minTrackingConfidence: number;
}

export interface WorkerDetectMessage {
  readonly type: "detect";
  readonly index: number;
  readonly timestampMs: number;
  readonly bitmap: ImageBitmap;
}

export interface WorkerCloseMessage {
  readonly type: "close";
}

export type WorkerRequest = WorkerInitMessage | WorkerDetectMessage | WorkerCloseMessage;

export type WorkerResponse =
  | { readonly type: "ready" }
  | {
      readonly type: "result";
      readonly index: number;
      readonly timestampMs: number;
      readonly detected: boolean;
      readonly image: RawLandmark[] | null;
      readonly world: RawLandmark[] | null;
    }
  | { readonly type: "error"; readonly index: number | null; readonly message: string };

/** MediaPipe's landmark shape, normalised into ours. */
interface MediaPipeLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * MediaPipe leaves `visibility` undefined on world landmarks in some builds.
 * Treating undefined as zero would silently discard every world landmark, so
 * it is treated as "no opinion" and paired with the image landmark's value by
 * the caller.
 *
 * ONE NUMBER, NOT TWO. The tasks API surfaces `visibility` and nothing else.
 * This used to also emit a `presence` field set to the same value, which made
 * the overlay show two figures that always agreed because they were the same
 * figure printed twice -- and gave the floors in `toCameraFrame` a second
 * test that could never reject anything the first had not. A number Clarity
 * invented, presented as a second opinion from the detector, is exactly the
 * kind of thing the evidence layer exists not to do.
 */
const normaliseLandmark = (landmark: MediaPipeLandmark, fallback: number): RawLandmark => ({
  x: landmark.x,
  y: landmark.y,
  z: landmark.z,
  visibility: landmark.visibility ?? fallback,
});

let landmarker: PoseLandmarker | null = null;

const post = (message: WorkerResponse, transfer: Transferable[] = []) => {
  (self as unknown as Worker).postMessage(message, transfer);
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === "init") {
      const fileset = await FilesetResolver.forVisionTasks(request.wasmRoot);
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: request.modelAssetPath },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: request.minPoseDetectionConfidence,
        minPosePresenceConfidence: request.minPosePresenceConfidence,
        minTrackingConfidence: request.minTrackingConfidence,
        outputSegmentationMasks: false,
      });
      post({ type: "ready" });
      return;
    }

    if (request.type === "detect") {
      if (!landmarker) throw new Error("detect before init");

      let result;
      try {
        result = landmarker.detectForVideo(request.bitmap, request.timestampMs);
      } finally {
        // Always, even when detection throws: a leaked bitmap is GPU memory
        // that will not come back.
        request.bitmap.close();
      }

      const image = result.landmarks?.[0];
      const world = result.worldLandmarks?.[0];

      if (!image?.length && !world?.length) {
        post({
          type: "result",
          index: request.index,
          timestampMs: request.timestampMs,
          detected: false,
          image: null,
          world: null,
        });
        return;
      }

      // The image landmarks carry the visibility MediaPipe is most confident
      // about; the world landmarks inherit it where their own is absent.
      const imageLandmarks = image
        ? image.map((landmark) => normaliseLandmark(landmark, 1))
        : null;
      const worldLandmarks = world
        ? world.map((landmark, index) =>
            normaliseLandmark(landmark, imageLandmarks?.[index]?.visibility ?? 1)
          )
        : null;

      post({
        type: "result",
        index: request.index,
        timestampMs: request.timestampMs,
        detected: true,
        image: imageLandmarks,
        world: worldLandmarks,
      });
      return;
    }

    if (request.type === "close") {
      landmarker?.close();
      landmarker = null;
      self.close();
    }
  } catch (error) {
    if (request.type === "detect") request.bitmap.close();
    post({
      type: "error",
      index: request.type === "detect" ? request.index : null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
