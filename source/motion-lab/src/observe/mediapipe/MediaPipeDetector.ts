/**
 * MediaPipe Pose, from the main thread.
 *
 * Owns the worker and serialises requests onto it. One frame is in flight at
 * a time, deliberately: `detectForVideo` carries tracking state between calls
 * and requires timestamps to increase, so overlapping requests would not just
 * be unsafe, they would silently degrade the tracking this whole layer exists
 * to capture.
 */

/*
 * THE WORKER MUST BE CLASSIC, NOT A MODULE WORKER.
 *
 * `@mediapipe/tasks-vision` loads its WASM with `importScripts`, which exists
 * only in classic workers. In a module worker it is undefined, the library
 * falls through to a branch that wants a `document` -- which no worker has --
 * and the loader never runs. The symptom is a bare "ModuleFactory not set",
 * which says nothing about worker type and sends you looking at wasm paths.
 *
 * Neither of Vite's two worker routes can deliver that in dev: the dev server
 * rewrites `?worker` imports to `{ type: "module" }` unconditionally, and
 * `new Worker(new URL(...))` serves untransformed ES source that a classic
 * worker cannot parse. So the worker is bundled by a small plugin in
 * vite.lab.config.ts and served at a fixed path, identically in dev and build.
 */
const POSE_WORKER_URL = "/pose-worker.js";

import { undetectedFrame, type DetectorImage, type PoseDetector } from "../detector";
import type { ObservationFrame } from "../observation";
import type { WorkerRequest, WorkerResponse } from "./poseWorker";

export interface MediaPipeOptions {
  /**
   * Directory holding the WASM binaries and their loaders. Served from
   * node_modules by the lab's Vite plugin, so the lab works offline.
   */
  readonly wasmRoot?: string;
  /**
   * The pose model.
   *
   * Pinned to a dated release rather than `latest`. A URL ending in `latest`
   * means the model can change underneath a saved analysis, so two runs over
   * the same video could disagree with no change on our side and nothing to
   * point at.
   */
  readonly modelAssetPath?: string;
  readonly minPoseDetectionConfidence?: number;
  readonly minPosePresenceConfidence?: number;
  readonly minTrackingConfidence?: number;
}

const DEFAULT_WASM_ROOT = "/mediapipe-wasm";

/**
 * `pose_landmarker_full` rather than `lite`.
 *
 * Lite is the right choice for a live camera on a phone. This is offline
 * analysis of a recorded swing, where a few extra milliseconds per frame cost
 * nothing and the accuracy goes straight into the reconstruction. Heavy is
 * available too and is worth trying once there are real swings to compare on.
 */
const DEFAULT_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

interface Pending {
  readonly resolve: (frame: ObservationFrame) => void;
  readonly reject: (error: Error) => void;
  readonly index: number;
  readonly timestampMs: number;
}

export class MediaPipeDetector implements PoseDetector {
  readonly name: string;

  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private pending: Pending | null = null;

  constructor(private readonly options: MediaPipeOptions = {}) {
    const model = options.modelAssetPath ?? DEFAULT_MODEL;
    this.name = `mediapipe:${model.split("/").pop() ?? model}`;
  }

  initialise(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = new Promise<void>((resolve, reject) => {
      const worker = new Worker(POSE_WORKER_URL);
      this.worker = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        if (message.type === "ready") {
          resolve();
          return;
        }

        if (message.type === "error") {
          const error = new Error(message.message);
          // An error before the first frame is an init failure; after it, it
          // belongs to the frame in flight. Rejecting the wrong one leaves the
          // other hanging forever.
          if (this.pending) {
            const pending = this.pending;
            this.pending = null;
            pending.reject(error);
          } else {
            reject(error);
          }
          return;
        }

        if (message.type === "result") {
          const pending = this.pending;
          this.pending = null;
          pending?.resolve({
            index: message.index,
            timestampMs: message.timestampMs,
            detected: message.detected,
            image: message.image,
            world: message.world,
            club: null,
          });
        }
      };

      worker.onerror = (event) => {
        const error = new Error(event.message || "pose worker failed");
        if (this.pending) {
          const pending = this.pending;
          this.pending = null;
          pending.reject(error);
        }
        reject(error);
      };

      const init: WorkerRequest = {
        type: "init",
        wasmRoot: this.options.wasmRoot ?? DEFAULT_WASM_ROOT,
        modelAssetPath: this.options.modelAssetPath ?? DEFAULT_MODEL,
        minPoseDetectionConfidence: this.options.minPoseDetectionConfidence ?? 0.5,
        minPosePresenceConfidence: this.options.minPosePresenceConfidence ?? 0.5,
        minTrackingConfidence: this.options.minTrackingConfidence ?? 0.5,
      };
      worker.postMessage(init);
    });

    return this.ready;
  }

  async detect(
    image: DetectorImage,
    index: number,
    timestampMs: number
  ): Promise<ObservationFrame> {
    await this.initialise();
    const worker = this.worker;
    if (!worker) return undetectedFrame(index, timestampMs);
    if (this.pending) throw new Error("detect called while a frame was still in flight");

    const bitmap = image instanceof ImageBitmap ? image : await createImageBitmap(image);

    return new Promise<ObservationFrame>((resolve, reject) => {
      this.pending = { resolve, reject, index, timestampMs };
      const request: WorkerRequest = { type: "detect", index, timestampMs, bitmap };
      // Transferred, not copied: ownership moves to the worker, which closes
      // it. A copy per frame would be a full-resolution allocation each time.
      worker.postMessage(request, [bitmap]);
    });
  }

  close() {
    this.worker?.postMessage({ type: "close" } satisfies WorkerRequest);
    // The worker calls self.close() on that message, but terminate() also
    // covers the case where it never finished initialising and is not
    // listening.
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.pending?.reject(new Error("detector closed"));
    this.pending = null;
  }
}
