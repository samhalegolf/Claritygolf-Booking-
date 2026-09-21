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
import { detectClubhead } from "./club/clubheadDetector";
import { buildClubheadHint } from "./club/clubheadHint";
import { toGrayFrame, type GrayFrame } from "./club/grayFrame";
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
  /** Frames a clubhead was found in. */
  readonly clubDetections: number;
  readonly elapsedMs: number;
}

export interface ObserveVideoOptions {
  readonly detector: PoseDetector;
  /**
   * Working width for the clubhead search, in pixels. The clubhead is found
   * by motion, which survives downsampling far better than detail does, so
   * this is small on purpose. Zero turns the search off entirely.
   */
  readonly clubSearchWidth?: number;
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
    let clubDetections = 0;
    let lastActualTimeMs = Number.NEGATIVE_INFINITY;

    /*
     * A rolling window of three frames for the clubhead search.
     *
     * The clubhead's CURRENT position differs from the previous frame and
     * from the next one; where it used to be differs only from the previous.
     * So the middle frame of any three is the one that can be searched, and
     * the window trails one frame behind the pose detection.
     */
    const searchWidth = options.clubSearchWidth ?? 192;
    const clubs = new Map<number, NonNullable<ObservationFrame["club"]>>();
    const window: { gray: GrayFrame; observation: ObservationFrame }[] = [];
    const surface = makeSearchSurface(searchWidth, info.width, info.height);

    const searchMiddle = (final: boolean) => {
      if (!surface) return;
      const needed = final ? 2 : 3;
      if (window.length < needed) return;

      const middleIndex = final ? window.length - 1 : 1;
      const middle = window[middleIndex];
      const hint = buildClubheadHint(middle.observation);
      if (!hint) return;

      const detection = detectClubhead(
        window[middleIndex - 1].gray,
        middle.gray,
        final ? null : window[2].gray,
        hint
      );
      if (!detection) return;

      // Collected by frame index and merged below, rather than written back
      // into an observation that has already been handed out. The club is
      // separate evidence about a frame, not a correction to it.
      clubs.set(middle.observation.index, {
        imageX: detection.imageX,
        imageY: detection.imageY,
        imageRadius: detection.imageRadius,
        confidence: detection.confidence,
      });
      clubDetections += 1;
    };

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

      /*
       * The pixels have to be read BEFORE the bitmap is handed to the pose
       * worker, because transferring it neuters the handle on this side. It
       * is drawn straight into a small canvas, so the downscale costs one
       * GPU blit rather than a loop over two million pixels.
       */
      const gray = surface ? surface.read(frame.bitmap) : null;

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

      if (gray) {
        window.push({ gray, observation: result });
        searchMiddle(false);
        if (window.length >= 3) window.shift();
      }

      options.onProgress?.({
        index: frame.index,
        total: info.frameCount,
        detected,
        elapsedMs: performance.now() - started,
      });
    }

    // The last frame has no successor, so it gets the weaker two-frame
    // search rather than none at all.
    searchMiddle(true);

    const withClubs: ObservationFrame[] = raw.map((frame) =>
      clubs.has(frame.index) ? { ...frame, club: clubs.get(frame.index)! } : frame
    );

    const camera: CameraObservationSequence = {
      space: "camera",
      frames: withClubs.map((frame) => toCameraFrame(frame, options.mapping)),
      fps: info.fps,
      width: info.width,
      height: info.height,
      durationMs: info.durationMs,
      detector: options.detector.name,
    };

    return {
      raw: withClubs,
      camera,
      world: anchorSequence(camera),
      info,
      undetectedFrames: raw.length - detected,
      duplicateDecodes,
      clubDetections,
      elapsedMs: performance.now() - started,
    };
  } finally {
    release();
  }
};

/**
 * A small canvas the frames are blitted into for the clubhead search.
 *
 * Reused across the whole clip: allocating a canvas per frame would churn
 * several hundred GPU surfaces over a two-second swing. Returns null when
 * the search is switched off or no 2D context is available, and the caller
 * simply does without a club rather than failing.
 */
const makeSearchSurface = (
  targetWidth: number,
  sourceWidth: number,
  sourceHeight: number
): { read: (bitmap: ImageBitmap) => GrayFrame | null } | null => {
  if (targetWidth <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null;
  if (typeof OffscreenCanvas === "undefined") return null;

  const width = Math.min(targetWidth, sourceWidth);
  const height = Math.max(1, Math.round((width / sourceWidth) * sourceHeight));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  return {
    read: (bitmap) => {
      try {
        context.drawImage(bitmap, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        // Already at the working size, so no further downsampling.
        return toGrayFrame(pixels.data, width, height, width);
      } catch {
        return null;
      }
    },
  };
};
