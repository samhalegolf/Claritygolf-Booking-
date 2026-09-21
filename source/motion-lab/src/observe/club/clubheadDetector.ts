/**
 * Finding the clubhead in the picture.
 *
 * There is no trained clubhead model to reach for, so this uses the one thing
 * that is reliably true of a clubhead and of nothing else in the frame: IT IS
 * THE FASTEST-MOVING OBJECT IN A GOLF SWING, by a wide margin. A hand peaks
 * around 9 m/s; a clubhead passes 20 and often 40. Between two frames at 60Hz
 * it moves half a metre while the body moves a centimetre or two.
 *
 * So the search is over the frame difference, not the frame. Nothing about
 * the clubhead's appearance is assumed -- not its colour, shape or size --
 * because a clubhead can be chrome, black or matte against grass, sky or a
 * net, and none of that survives contact with a real driving range.
 *
 * WHERE THE GOLF KNOWLEDGE GOES
 *
 * The plan draws a line: golf knowledge may be used to FIND the relevant
 * things, but not to decide how they moved. Everything here is on the finding
 * side. The body is masked out because a clubhead is not a torso. The search
 * is bounded to a club's length from the hands because a clubhead is on the
 * end of a club. Neither says anything about where within that region the
 * club went, or how it got there.
 *
 * WHERE IT IS, NOT WHERE IT WAS
 *
 * A two-frame difference cannot tell those apart. It lights up at both the
 * clubhead's old position and its new one, and with a fast club and a short
 * shutter those are two separate blobs of identical brightness -- so the
 * detector has a fifty-fifty chance of reporting a stale position.
 *
 * A third frame settles it, and this is offline analysis so the third frame
 * is simply there. The clubhead's CURRENT position differs from the previous
 * frame AND from the next one; where it used to be differs only from the
 * previous. Taking the smaller of the two differences at each pixel therefore
 * keeps the present and cancels the past.
 *
 * Without a next frame -- the last frame of a clip -- it falls back to two
 * frames and the old ambiguity returns. That is reported through the radius
 * rather than hidden.
 *
 * WHAT IT STILL DOES NOT SOLVE
 *
 * Motion blur within a single exposure. A fast clubhead is a streak, and its
 * centre is genuinely spread along that streak. The reported radius spans it,
 * so a wide detection is an uncertain one and the club model weighs it
 * accordingly.
 */

import type { Unit } from "../../contracts";
import type { ClubObservation } from "../observation";
import { differenceOf, type GrayFrame } from "./grayFrame";

/**
 * What the body tells the detector about where to look.
 *
 * All in NORMALISED image coordinates, 0..1 with Y down -- the same frame the
 * detector's own landmarks arrive in, so the caller never has to convert.
 */
export interface ClubheadHint {
  /** Where the hands are. The club starts here. */
  readonly hands: readonly [number, number];
  /** Body landmarks to mask out, with the radius to mask around each. */
  readonly bodyPoints: readonly (readonly [number, number])[];
  readonly bodyMaskRadius: number;
  /** Nearest and furthest a clubhead could plausibly be from the hands. */
  readonly minReach: number;
  readonly maxReach: number;
}

export interface ClubheadDetectorOptions {
  /**
   * Multiples of the frame's own robust difference level. The clubhead
   * outruns everything else by a factor of ten or more, so this does not need
   * to be delicate -- and a low threshold would find the grass moving.
   */
  readonly sigmas?: number;
  /** Ignore blobs smaller than this fraction of the working image. */
  readonly minBlobFraction?: number;
  /** Ignore blobs larger than this: a whole-frame change is a camera move. */
  readonly maxBlobFraction?: number;
}

const DEFAULTS = {
  sigmas: 6,
  minBlobFraction: 0.00015,
  maxBlobFraction: 0.04,
} as const;

export interface ClubheadDetection extends ClubObservation {
  /** Pixels in the winning blob, at the working resolution. */
  readonly blobPixels: number;
  /** Difference energy in it, for the debug readout. */
  readonly energy: number;
}

interface Blob {
  sumX: number;
  sumY: number;
  weight: number;
  pixels: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Detect a clubhead between two frames.
 *
 * `previous` and `current` must be the same size. Returns null when nothing
 * plausible moved -- which is a real answer, not a failure: the club is
 * genuinely still at address and genuinely gone once it leaves the frame.
 */
export const detectClubhead = (
  previous: GrayFrame,
  current: GrayFrame,
  next: GrayFrame | null,
  hint: ClubheadHint,
  options: ClubheadDetectorOptions = {}
): ClubheadDetection | null => {
  if (previous.width !== current.width || previous.height !== current.height) return null;
  if (next && (next.width !== current.width || next.height !== current.height)) return null;

  const sigmas = options.sigmas ?? DEFAULTS.sigmas;
  const { width, height } = current;
  const total = width * height;

  // Three-frame difference where a next frame exists: the minimum of the two
  // keeps what is different from BOTH neighbours, which is where the club is
  // now, and cancels where it was.
  const backward = differenceOf(previous, current).data;
  const difference = next
    ? (() => {
        const forward = differenceOf(current, next).data;
        const combined = new Uint8ClampedArray(backward.length);
        for (let i = 0; i < backward.length; i += 1) {
          combined[i] = Math.min(backward[i], forward[i]);
        }
        return combined;
      })()
    : backward;

  /* ---- mask: the body, and anywhere a club cannot reach ---- */

  const maskRadiusSq = (hint.bodyMaskRadius * width) ** 2;
  const minReachSq = (hint.minReach * width) ** 2;
  const maxReachSq = (hint.maxReach * width) ** 2;
  const handsX = hint.hands[0] * width;
  const handsY = hint.hands[1] * width;

  // Y is scaled by WIDTH, not height, so a distance in the mask is the same
  // physical distance whichever way it points. Scaling each axis by its own
  // dimension would make every radius an ellipse on a non-square frame.
  const bodyX = hint.bodyPoints.map((point) => point[0] * width);
  const bodyY = hint.bodyPoints.map((point) => point[1] * width);

  const masked = new Float32Array(total);
  for (let y = 0; y < height; y += 1) {
    const py = y;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const value = difference[index];
      if (value === 0) continue;

      const fromHandsSq = (x - handsX) ** 2 + (py - handsY) ** 2;
      if (fromHandsSq < minReachSq || fromHandsSq > maxReachSq) continue;

      let inBody = false;
      for (let b = 0; b < bodyX.length; b += 1) {
        if ((x - bodyX[b]) ** 2 + (py - bodyY[b]) ** 2 < maskRadiusSq) {
          inBody = true;
          break;
        }
      }
      if (inBody) continue;

      masked[index] = value;
    }
  }

  /* ---- threshold, robustly ---- */

  const survivors: number[] = [];
  for (let i = 0; i < total; i += 1) if (masked[i] > 0) survivors.push(masked[i]);
  if (survivors.length < 4) return null;

  /*
   * A guard against the whole picture changing: a pan, a shake, an exposure
   * jump. A clubhead is a small bright thing in a mostly-still frame, so when
   * most of the searchable area is moving, whatever is happening is not a
   * golf club and no blob within it can be trusted.
   */
  let searchable = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fromHandsSq = (x - handsX) ** 2 + (y - handsY) ** 2;
      if (fromHandsSq >= minReachSq && fromHandsSq <= maxReachSq) searchable += 1;
    }
  }
  if (searchable > 0 && survivors.length / searchable > 0.5) return null;

  survivors.sort((a, b) => a - b);
  const median = survivors[Math.floor(survivors.length / 2)];
  const deviations = survivors.map((value) => Math.abs(value - median));
  deviations.sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] * 1.4826;

  // A floor, for the case the difference image is almost entirely still: a
  // MAD of zero would make any single bright pixel infinitely significant.
  const threshold = Math.max(median + sigmas * mad, 12);

  /* ---- connected components ---- */

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let best: Blob | null = null;
  let bestScore = 0;

  const minPixels = Math.max(2, Math.floor(total * (options.minBlobFraction ?? DEFAULTS.minBlobFraction)));
  const maxPixels = Math.floor(total * (options.maxBlobFraction ?? DEFAULTS.maxBlobFraction));

  for (let seed = 0; seed < total; seed += 1) {
    if (visited[seed] || masked[seed] < threshold) continue;

    let head = 0;
    let tail = 0;
    queue[tail] = seed;
    tail += 1;
    visited[seed] = 1;

    const blob: Blob = {
      sumX: 0, sumY: 0, weight: 0, pixels: 0,
      minX: width, maxX: 0, minY: height, maxY: 0,
    };

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = (index - x) / width;
      const value = masked[index];

      blob.sumX += x * value;
      blob.sumY += y * value;
      blob.weight += value;
      blob.pixels += 1;
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;

      // Four-connected. Eight would bridge two separate fast objects through
      // a diagonal touch, which is exactly the merge worth avoiding.
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || visited[next] || masked[next] < threshold) continue;
        visited[next] = 1;
        queue[tail] = next;
        tail += 1;
      }
    }

    if (blob.pixels < minPixels || blob.pixels > maxPixels) continue;

    // The brightest-moving blob wins. Not the biggest: a slow arm crossing a
    // dark background can be large and dim, while a clubhead is small and
    // violent.
    if (blob.weight > bestScore) {
      bestScore = blob.weight;
      best = blob;
    }
  }

  if (!best || best.weight <= 0) return null;

  const centreX = best.sumX / best.weight / width;
  const centreY = best.sumY / best.weight / width;

  /*
   * The radius spans the whole difference blob, which for a moving clubhead
   * covers where it was AND where it is. Reporting it honestly is what tells
   * the club model that a fast frame's detection is less precise than a slow
   * one's.
   */
  const radius =
    Math.max(best.maxX - best.minX, best.maxY - best.minY) / (2 * width);

  return {
    imageX: centreX,
    imageY: centreY,
    imageRadius: radius,
    confidence: confidenceOf(best, threshold, radius, hint),
    blobPixels: best.pixels,
    energy: best.weight,
  };
};

/**
 * How much to believe a detection.
 *
 * Three things, all of them reasons it might not be a clubhead:
 *
 *   how far above the noise the blob actually stood -- a blob that just
 *     scraped the threshold is as likely to be a leaf;
 *   how compact it is -- a clubhead is a small fast thing, and a long smear
 *     across the frame is a camera shake or a passing person;
 *   how much of the plausible search area it occupies, since a detection
 *     spanning half the swing arc has not localised anything.
 */
const confidenceOf = (
  blob: Blob,
  threshold: number,
  radius: number,
  hint: ClubheadHint
): Unit => {
  const mean = blob.weight / blob.pixels;
  const aboveNoise = Math.min(1, Math.max(0, (mean - threshold) / Math.max(threshold, 1)));

  const span = Math.max(blob.maxX - blob.minX, blob.maxY - blob.minY);
  const shorter = Math.min(blob.maxX - blob.minX, blob.maxY - blob.minY);
  // Elongation is expected -- a blurred clubhead is a streak -- so this only
  // penalises the extreme case of a line across the whole frame.
  const compact = Math.min(1, Math.max(0, 1 - (span - shorter) / Math.max(span * 4, 1)));

  const localised = Math.min(1, Math.max(0, 1 - radius / Math.max(hint.maxReach * 0.6, 1e-6)));

  return Math.min(1, Math.max(0, 0.25 + 0.45 * aboveNoise + 0.15 * compact + 0.15 * localised));
};
