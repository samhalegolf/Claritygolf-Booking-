/**
 * The detector seam.
 *
 * Two implementations exist: MediaPipe, and a synthetic one that makes up
 * detector output from a known body. The second is not a stub -- it is how
 * the whole pipeline is tested against ground truth, which no real video can
 * provide.
 *
 * Keeping this an interface rather than reaching for MediaPipe directly is
 * what lets Build 3 be built and graded before a single frame of real footage
 * exists, and what would let a second detector be added later as a change to
 * `observe/` and nowhere else.
 */

import type { ObservationFrame } from "./observation";

/** Anything MediaPipe will accept as an image. */
export type DetectorImage = ImageBitmap | HTMLVideoElement | HTMLCanvasElement;

export interface PoseDetector {
  /** Which detector and model this is, for the debug panel. */
  readonly name: string;
  initialise(): Promise<void>;
  /**
   * Timestamps must increase. MediaPipe's VIDEO mode keeps internal tracking
   * state keyed on them and will reject a step backwards, so frames are
   * processed in order.
   */
  detect(image: DetectorImage, index: number, timestampMs: number): Promise<ObservationFrame>;
  close(): void;
}

/** A frame that produced nothing. A real, reportable state -- not an error. */
export const undetectedFrame = (index: number, timestampMs: number): ObservationFrame => ({
  index,
  timestampMs,
  detected: false,
  image: null,
  world: null,
  club: null,
});
