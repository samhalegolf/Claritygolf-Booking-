/**
 * Swing phases from a clip, without opening the 3D view.
 *
 * The same detector and frame walk the lab uses (observe/runObservation),
 * stopped before reconstruction: phases are times, and times need only what
 * the detector saw. A host calls this with the clip it already has on screen
 * and gets clip-time milliseconds back, on the same clock as that clip's
 * <video>.currentTime.
 *
 * The clubhead search is switched off -- it is the slowest part of a frame
 * and phases do not read it -- and a high-frame-rate clip is sampled down to
 * about 60 a second, because a slow-motion clip at every frame would take
 * minutes to find six moments.
 */

import { MediaPipeDetector } from "../observe/mediapipe/MediaPipeDetector";
import { observeVideo } from "../observe/runObservation";
import { openVideo } from "../observe/videoFrames";
import { findSwingPhases, type SwingPhases } from "../motion/phases/swingPhases";

export type { SwingPhase, SwingPhaseKey, SwingPhases } from "../motion/phases/swingPhases";
export { SWING_PHASE_ORDER } from "../motion/phases/swingPhases";

export interface DetectSwingPhasesOptions {
  readonly signal?: AbortSignal;
  /** 0..1 through the clip. */
  readonly onProgress?: (fraction: number) => void;
  /** The clip's frame rate, when the host already knows it. Saves a probe. */
  readonly fps?: number;
}

const TARGET_SAMPLES_PER_SECOND = 60;

export const detectSwingPhases = async (
  clip: Blob,
  options: DetectSwingPhasesOptions = {}
): Promise<SwingPhases> => {
  let fps = options.fps && options.fps > 0 ? options.fps : 0;
  if (!fps) {
    // Opened once just to measure the frame rate; observeVideo opens its own.
    const probe = await openVideo(clip);
    fps = probe.info.fps;
    probe.release();
  }

  const detector = new MediaPipeDetector();
  try {
    const result = await observeVideo(clip, {
      detector,
      signal: options.signal,
      clubSearchWidth: 0,
      stride: Math.max(1, Math.round(fps / TARGET_SAMPLES_PER_SECOND)),
      onProgress: (progress) =>
        options.onProgress?.(progress.total ? progress.index / progress.total : 0),
    });
    return findSwingPhases(result.raw);
  } finally {
    detector.close();
  }
};
