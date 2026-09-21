/**
 * Video in, observations out.
 *
 * The orchestration only. Frame extraction, detection, relabelling and
 * anchoring each live in their own file and are each testable on their own;
 * this walks them in order and reports progress.
 *
 * Both the camera-space and world-space sequences come back. The camera one
 * is not an intermediate to be thrown away -- it is what the raw debug
 * overlay draws, and the overlay's job is to stay honest about what the
 * detector could actually see, before any anchoring moved anything.
 */

import { anchorSequence } from "./anchor";
import type { PoseDetector } from "./detector";
import { undetectedFrame } from "./detector";
import type {
  CameraObservationSequence,
  ObservationFrame,
  WorldObservationSequence,
} from "./observation";
import { toCameraFrame, type ToCameraFrameOptions } from "./toCameraFrame";
import { extractFrames, openVideo, type VideoSourceInfo } from "./videoFrames";

export interface ObservationProgress {
  readonly index: number;
  readonly total: number;
  readonly detected: number;
  readonly elapsedMs: number;
}

export interface ObservationResult {
  /**
   * Detector output, untouched. Kept because the raw overlay draws it: the
   * evidence layer's job is to show what the detector could actually see,
   * which means all 33 landmarks including the ones Clarity has no use for,
   * at the visibility the detector reported.
   */
  readonly raw: readonly ObservationFrame[];
  readonly camera: CameraObservationSequence;
  readonly world: WorldObservationSequence;
  readonly info: VideoSourceInfo;
  /** Frames the detector found nothing in. A real result, not a failure. */
  readonly undetectedFrames: number;
  /** Frames where seeking landed on a decode we had already seen. */
  readonly duplicateDecodes: number;
  readonly elapsedMs: number;
}

export interface ObserveVideoOptions {
  readonly detector: PoseDetector;
  readonly signal?: AbortSignal;
  readonly stride?: number;
  readonly onProgress?: (progress: ObservationProgress) => void;
  readonly mapping?: ToCameraFrameOptions;
}

export const observeVideo = async (
  file: File | Blob,
  options: ObserveVideoOptions
): Promise<ObservationResult> => {
  const started = performance.now();
  const { video, info, release } = await openVideo(file);

  try {
    await options.detector.initialise();

    const raw: ObservationFrame[] = [];
    let detected = 0;
    let duplicateDecodes = 0;
    let lastActualTimeMs = Number.NEGATIVE_INFINITY;

    for await (const frame of extractFrames(video, info, {
      signal: options.signal,
      stride: options.stride,
    })) {
      // Landing on the same decoded frame twice happens on variable-frame-rate
      // sources. Counted and reported rather than hidden: it tells the Motion
      // Layer that two "different" frames carry identical evidence, which is
      // not the same as the golfer having held still.
      if (Math.abs(frame.actualTimeMs - lastActualTimeMs) < 1e-6) duplicateDecodes += 1;
      lastActualTimeMs = frame.actualTimeMs;

      let result: ObservationFrame;
      try {
        result = await options.detector.detect(frame.bitmap, frame.index, frame.timestampMs);
      } catch {
        // One frame failing is not the run failing. It becomes an undetected
        // frame, which the whole pipeline already knows how to handle, and the
        // count surfaces it.
        result = undetectedFrame(frame.index, frame.timestampMs);
      }

      if (result.detected) detected += 1;
      raw.push(result);

      options.onProgress?.({
        index: frame.index,
        total: info.frameCount,
        detected,
        elapsedMs: performance.now() - started,
      });
    }

    const camera: CameraObservationSequence = {
      space: "camera",
      frames: raw.map((frame) => toCameraFrame(frame, options.mapping)),
      fps: info.fps,
      width: info.width,
      height: info.height,
      durationMs: info.durationMs,
      detector: options.detector.name,
    };

    return {
      raw,
      camera,
      world: anchorSequence(camera),
      info,
      undetectedFrames: raw.length - detected,
      duplicateDecodes,
      elapsedMs: performance.now() - started,
    };
  } finally {
    release();
  }
};
