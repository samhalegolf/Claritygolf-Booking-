/**
 * Per-joint tracks: the shape the reconstruction actually works in.
 *
 * An observation sequence is organised by FRAME, which is how it arrives and
 * how it is rendered. Reconstruction asks questions along the other axis --
 * "where has this wrist been, and where is it going?" -- and answering that
 * from frame-major data means walking the whole sequence for every question.
 *
 * A track is a joint's whole history: one slot per frame, null where nothing
 * was seen. The nulls are the point. They are what the gap logic reads, and
 * keeping them as nulls rather than as zeroes or as absent keys means a gap
 * has a length and a position rather than just being missing data.
 */

import type { ClarityJoint, Unit, Vec3 } from "../../contracts";
import { CLARITY_JOINTS } from "../../contracts";
import type { WorldObservationSequence } from "../../observe/observation";

export interface TrackSample {
  readonly position: Vec3;
  /** The detector's own confidence, carried through untouched. */
  readonly visibility: Unit;
}

/** One joint's history. `samples[i]` is null when frame i did not see it. */
export interface Track {
  readonly joint: ClarityJoint;
  readonly samples: (TrackSample | null)[];
}

export type Tracks = Record<ClarityJoint, Track>;

export const buildTracks = (sequence: WorldObservationSequence): Tracks => {
  const frameCount = sequence.frames.length;
  const tracks = {} as Tracks;

  for (const joint of CLARITY_JOINTS) {
    const samples: (TrackSample | null)[] = new Array(frameCount).fill(null);
    for (let index = 0; index < frameCount; index += 1) {
      const observed = sequence.frames[index].joints[joint];
      if (!observed) continue;
      samples[index] = {
        position: observed.position as Vec3,
        visibility: observed.visibility,
      };
    }
    tracks[joint] = { joint, samples };
  }

  return tracks;
};

/** A run of consecutive frames with no observation. */
export interface Gap {
  /** First missing frame. */
  readonly start: number;
  /** Last missing frame. */
  readonly end: number;
  readonly length: number;
  /**
   * Last observed frame before the gap, or null when the track starts missing.
   * A gap with no `before` cannot be bridged -- only extrapolated backwards --
   * and the distinction drives which provenance the frames get.
   */
  readonly before: number | null;
  /** First observed frame after the gap, or null when the track ends missing. */
  readonly after: number | null;
}

export const findGaps = (track: Track): Gap[] => {
  const gaps: Gap[] = [];
  const { samples } = track;
  let index = 0;

  while (index < samples.length) {
    if (samples[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < samples.length && !samples[index]) index += 1;
    const end = index - 1;

    gaps.push({
      start,
      end,
      length: end - start + 1,
      before: start > 0 ? start - 1 : null,
      after: index < samples.length ? index : null,
    });
  }

  return gaps;
};

/** Frames where this joint was actually seen. */
export const observedIndices = (track: Track): number[] => {
  const out: number[] = [];
  for (let index = 0; index < track.samples.length; index += 1) {
    if (track.samples[index]) out.push(index);
  }
  return out;
};

/**
 * Median absolute deviation, scaled to be comparable with a standard
 * deviation for normally distributed data.
 *
 * Used instead of a standard deviation throughout the reconstruction because
 * the quantities being measured are exactly the ones polluted by outliers --
 * a single wild detection inflates a standard deviation enough to hide
 * itself, which is precisely the wrong behaviour in an outlier detector.
 */
export const medianAbsoluteDeviation = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const median = medianOf(values);
  const deviations = values.map((value) => Math.abs(value - median));
  return medianOf(deviations) * 1.4826;
};

export const medianOf = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

/**
 * Estimate a track's measurement noise, in metres.
 *
 * From the LOW end of the midpoint-deviation distribution, not the middle.
 * The deviation of a smooth trajectory is (1/2)·a·dt², so the quiet passages
 * of a clip -- address, the pause at the top, the finish -- have essentially
 * no acceleration and their deviations are almost pure noise. The busy
 * passages add real acceleration on top, so a median would read a fast joint
 * as a noisy one and smooth the swing out of it.
 *
 * For independent noise of standard deviation s on each of three samples, the
 * midpoint deviation has standard deviation s·sqrt(3/2), hence the divisor.
 */
export const estimateNoise = (track: Track): number => {
  const deviations: number[] = [];
  for (let index = 1; index < track.samples.length - 1; index += 1) {
    const previous = track.samples[index - 1];
    const current = track.samples[index];
    const next = track.samples[index + 1];
    if (!previous || !current || !next) continue;
    deviations.push(
      Math.hypot(
        current.position[0] - (previous.position[0] + next.position[0]) / 2,
        current.position[1] - (previous.position[1] + next.position[1]) / 2,
        current.position[2] - (previous.position[2] + next.position[2]) / 2
      )
    );
  }
  if (deviations.length < 5) return 0;
  deviations.sort((a, b) => a - b);
  return deviations[Math.floor(deviations.length * 0.2)] / Math.sqrt(1.5);
};
