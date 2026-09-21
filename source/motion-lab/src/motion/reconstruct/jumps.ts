/**
 * Finding detections that cannot be real.
 *
 * THE MISTAKE THIS FILE EXISTS TO AVOID
 *
 * The obvious outlier test is speed: flag a joint that moved too far between
 * frames. It is also completely wrong here. A downswing hand travels past
 * 30 m/s, which is half a metre per frame at 60fps -- so any speed threshold
 * loose enough to allow a real golf swing is far too loose to catch a bad
 * detection, and any threshold tight enough to catch the detection deletes
 * the downswing. The plan is explicit that genuine rapid movement must be
 * preserved.
 *
 * WHAT IS USED INSTEAD
 *
 * The second difference: how far a sample sits from the midpoint of its two
 * neighbours. The arithmetic is decisive.
 *
 *   Real motion, however fast, deviates by about (1/2)·a·dt². It is SECOND
 *   order in dt. A hand accelerating at 175 m/s² -- roughly a real downswing
 *   -- deviates by 24mm at 60fps, no matter that it is moving at 30 m/s.
 *
 *   A bad detection deviates by the size of the error itself. It is FIRST
 *   order. A wrist landing 250mm away deviates by ~250mm.
 *
 * So the two are separated by an order of magnitude even in the hardest case,
 * and the test costs nothing in genuine acceleration. Velocity never enters
 * it.
 *
 * THE THRESHOLD HAS TO BE LOCAL, NOT PER-TRACK
 *
 * A per-joint threshold is not enough either, and the first version of this
 * flagged eight frames of a clean downswing to prove it. One hand is
 * motionless through a half-second address and then accelerates through
 * transition hard enough to deviate by 40mm a frame. A scale taken over the
 * whole track is dominated by the still part -- so it lands far below what
 * the moving part legitimately produces, and the swing itself reads as a
 * fault.
 *
 * So the scale is measured in a window around each frame. Quiet passages are
 * judged against quiet neighbours and violent ones against violent
 * neighbours, and a genuine outlier has to stand out from what the joint was
 * doing AT THE TIME rather than from its average behaviour over the clip.
 */

import type { Metres, Vec3 } from "../../contracts";
import { distance, lerpVec } from "../../contracts";
import type { Track } from "./tracks";
import { medianAbsoluteDeviation } from "./tracks";

export interface JumpFlag {
  readonly frame: number;
  /** How far off its neighbours' midpoint it sat. */
  readonly deviationM: Metres;
  /** The robust scale it was judged against, for the debug readout. */
  readonly scaleM: Metres;
}

export interface JumpOptions {
  /**
   * A second opinion from the rest of the body.
   *
   * A large second difference says a sample is SURPRISING, not that it is
   * wrong, and the two are genuinely different. A trail elbow folding to its
   * tightest point and springing back is surprising and completely real -- it
   * deviates 50mm from its neighbours' midpoint while every bone attached to
   * it stays exactly its measured length. A wrist detected on the background
   * is surprising and breaks the forearm.
   *
   * So when this is supplied, a flag also requires the body to disagree. It
   * is the plan's rule that connected structures are evidence, applied to
   * outlier rejection: without it, the detector must choose between flagging
   * real kinematics and missing real errors.
   */
  readonly isStructurallyImplausible?: (frame: number) => boolean;
  /**
   * Multiples of this joint's own robust deviation scale. Five is loose
   * enough that ordinary acceleration never reaches it and tight enough that
   * a detection landing on the background always does.
   */
  readonly sigmas?: number;
  /**
   * A floor, as a fraction of standing height. Without it a joint that barely
   * moves has a near-zero scale, and millimetres of ordinary jitter start
   * reading as jumps.
   */
  readonly floorFractionOfHeight?: number;
  readonly heightM?: number;
  /**
   * Half-width of the window the local scale is measured over, in frames.
   * Wide enough to hold a few dozen samples so the median is meaningful,
   * narrow enough that a still address does not set the standard for a
   * downswing a quarter of a second later.
   */
  readonly scaleHalfWindow?: number;
}

const DEFAULTS = {
  sigmas: 5,
  floorFractionOfHeight: 0.015,
  heightM: 1.8,
  scaleHalfWindow: 10,
} as const;

/** Deviation from the midpoint of the neighbours, where all three were seen. */
const deviationAt = (track: Track, index: number): number | null => {
  const previous = track.samples[index - 1];
  const current = track.samples[index];
  const next = track.samples[index + 1];
  if (!previous || !current || !next) return null;
  return distance(current.position, lerpVec(previous.position, next.position, 0.5));
};

export interface JumpReport {
  readonly flags: ReadonlyMap<number, JumpFlag>;
  /** The largest local scale seen. Indicative only; the test is per frame. */
  readonly scaleM: Metres;
  /** The largest local threshold used. Indicative only. */
  readonly thresholdM: Metres;
}

export const findJumps = (track: Track, options: JumpOptions = {}): JumpReport => {
  const sigmas = options.sigmas ?? DEFAULTS.sigmas;
  const heightM = options.heightM ?? DEFAULTS.heightM;
  const floor = (options.floorFractionOfHeight ?? DEFAULTS.floorFractionOfHeight) * heightM;

  const deviations: number[] = [];
  const byFrame = new Map<number, number>();

  for (let index = 1; index < track.samples.length - 1; index += 1) {
    const deviation = deviationAt(track, index);
    if (deviation === null) continue;
    deviations.push(deviation);
    byFrame.set(index, deviation);
  }

  // A track with almost nothing in it has no scale to speak of, and guessing
  // one would mean flagging or excusing samples on no evidence.
  if (deviations.length < 5) {
    return { flags: new Map(), scaleM: 0, thresholdM: Number.POSITIVE_INFINITY };
  }

  const halfWindow = options.scaleHalfWindow ?? DEFAULTS.scaleHalfWindow;
  const frames = [...byFrame.keys()].sort((a, b) => a - b);

  const flags = new Map<number, JumpFlag>();
  let widestScale = 0;
  let widestThreshold = 0;

  for (const frame of frames) {
    const deviation = byFrame.get(frame)!;

    // The scale for this frame, from its neighbourhood. The frame itself is
    // excluded: a large enough outlier would otherwise inflate the very
    // scale it is being judged against and excuse itself.
    const local: number[] = [];
    for (const other of frames) {
      if (other === frame) continue;
      if (Math.abs(other - frame) > halfWindow) continue;
      local.push(byFrame.get(other)!);
    }

    const scaleM =
      local.length >= 4 ? medianAbsoluteDeviation(local) : medianAbsoluteDeviation(deviations);
    const thresholdM = Math.max(floor, scaleM * sigmas);

    widestScale = Math.max(widestScale, scaleM);
    widestThreshold = Math.max(widestThreshold, thresholdM);

    if (deviation > thresholdM && (options.isStructurallyImplausible?.(frame) ?? true)) {
      flags.set(frame, { frame, deviationM: deviation, scaleM });
    }
  }

  return {
    flags: suppressNeighbours(flags),
    scaleM: widestScale,
    thresholdM: widestThreshold,
  };
};


/**
 * Keep only the peak of each run of adjacent flags.
 *
 * One bad sample corrupts THREE deviations, not one: frame i sits far from
 * its neighbours' midpoint, and frames i-1 and i+1 each have it as a
 * neighbour, so each of them is dragged about half as far. Without this, a
 * single wrist landing on the background reports three jumps and the two
 * innocent frames either side get repaired to a midpoint computed through the
 * bad one.
 *
 * The peak is the real outlier; the shoulders are its shadow.
 */
const suppressNeighbours = (
  flags: ReadonlyMap<number, JumpFlag>
): Map<number, JumpFlag> => {
  const kept = new Map<number, JumpFlag>();
  const frames = [...flags.keys()].sort((a, b) => a - b);

  let runStart = 0;
  while (runStart < frames.length) {
    let runEnd = runStart;
    while (runEnd + 1 < frames.length && frames[runEnd + 1] === frames[runEnd] + 1) {
      runEnd += 1;
    }

    let peak = frames[runStart];
    for (let i = runStart + 1; i <= runEnd; i += 1) {
      if (flags.get(frames[i])!.deviationM > flags.get(peak)!.deviationM) {
        peak = frames[i];
      }
    }
    kept.set(peak, flags.get(peak)!);
    runStart = runEnd + 1;
  }

  return kept;
};

/**
 * Replace a flagged sample with the midpoint of its neighbours.
 *
 * Deliberately the least imaginative repair available. The sample is known to
 * be wrong and its true position is not known, so the reconstruction states
 * the simplest thing consistent with the frames either side and records how
 * far it had to move -- which is what makes the correction visible in
 * provenance and payable in confidence, rather than silently absorbed.
 */
export const repairJump = (track: Track, index: number): Vec3 | null => {
  const previous = track.samples[index - 1];
  const next = track.samples[index + 1];
  if (!previous || !next) return null;
  return lerpVec(previous.position, next.position, 0.5);
};
