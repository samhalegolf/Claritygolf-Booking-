/**
 * Calibrating the camera's pitch from a shot of the golfer standing still.
 *
 * WHY A SECOND CLIP IS WORTH ASKING FOR
 *
 * The swing clip can only pin the pitch down when the golfer's mass leaves
 * their feet -- see `reconstruct/levelled`. That is a hard lower bound and
 * nothing more: five degrees of tilt is caught out by 1.6, and a clip whose
 * mass never nears the edge of the foot proves nothing at all. The admissible
 * range on a clean swing is about fifteen degrees wide.
 *
 * A standing shot collapses it, because it removes the thing that made the
 * pitch unmeasurable in the first place. At address the fore-aft profile
 * carries a huge posture term -- this fixture regresses to 10.7 degrees with
 * a perfectly level camera -- and nothing distinguishes that from a tilt.
 * Standing up, the body is close to a plumb line, so the slope is close to
 * the camera.
 *
 * TWO ESTIMATORS, AND WHY BOTH ARE KEPT
 *
 * The raw slope, `apparentLeanDeg`, is the camera's pitch plus however far
 * from vertical the person actually stood.
 *
 * That residual can be removed -- if the only thing they did was tilt at the
 * hip. Model an upright body rotated by phi about the hip: everything above
 * the hip moves forward by (h - hipHeight)*phi and everything below stays
 * put. The best line through that has a slope of exactly
 * `hipBend / hipHeight`, where `hipBend` is the pitch-free residual that
 * `observe/foreAft` already measures. So
 * `apparentLean - atan(hipBend / hipHeight)` is the camera, and measured on
 * the fixture it is exact to a hundredth of a degree at spine tilts from zero
 * to fifteen degrees.
 *
 * It is exact for a narrow reason, and the narrowness matters: the model has
 * ONE posture degree of freedom. Push the hips BACK -- a translation rather
 * than a rotation -- and the bend grows while the slope barely moves, so
 * subtracting it over-corrects. Measured with the hips 60mm back, a level
 * camera reads as -3.9 degrees. And pushing the hips back is the main thing a
 * golfer's lower body does.
 *
 * So neither estimator is safe alone, and they fail in opposite directions:
 * the raw slope is wrong when the person tilts, the corrected one when they
 * sit back. What is reported is the BRACKET between them, widened by a floor
 * for detector noise. It is wide exactly when the pose was ambiguous and
 * narrow when the person did what they were asked.
 *
 * WHAT TO ASK THE GOLFER FOR
 *
 * "Stand still and stand up straight, in the same place, from the same
 * camera." Still, because the estimate averages. Straight, because that is
 * what makes the two estimators agree. `standingBendM` reports how straight
 * they managed, so a shot that will not do can be rejected rather than
 * quietly believed.
 */

import type { ClarityJoint } from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import { foreAftProfile, lookupFrom, plantedIndices, postureShape } from "../../observe/foreAft";
import type { CameraObservationSequence, WorldObservationFrame } from "../../observe/observation";

export interface StandingCalibration {
  /** The camera's pitch, degrees. The middle of `pitchRangeDeg`. */
  readonly pitchDeg: number;
  /** The interval the two estimators bracket, widened for detector noise. */
  readonly pitchRangeDeg: readonly [number, number];
  /**
   * How far from a plumb line they stood, metres -- the pitch-free bend at the
   * hip. Small is what makes this shot worth having: 3mm standing straight,
   * 29mm at five degrees of spine tilt, 79mm at fifteen.
   */
  readonly standingBendM: number;
  /** Still, planted frames the estimate averaged over. */
  readonly samples: number;
  /** Whether this shot should be used to calibrate anything. */
  readonly usable: boolean;
  /** Why not, when it is not. Null when the shot is usable. */
  readonly reason: string | null;
}

export interface StandingShotOptions {
  /**
   * Per-joint movement between frames below which the golfer counts as still,
   * metres. Generous: this wants someone who is not WALKING, not someone
   * frozen.
   */
  readonly stillnessThresholdM?: number;
  /**
   * How far from upright they may stand and still be calibrated from, metres
   * of hip bend. Above this the two estimators are too far apart to average:
   * the pose was a crouch, not a stand.
   */
  readonly maxBendM?: number;
  /** Fewest still frames worth averaging. */
  readonly minSamples?: number;
}

const DEFAULTS = {
  stillnessThresholdM: 0.015,
  /** ~3.3 degrees of posture on a 0.87m hip: looser than "straight", tighter than a crouch. */
  maxBendM: 0.05,
  minSamples: 10,
} as const;

/**
 * Detector noise floor on the estimate, degrees.
 *
 * The bracket closes to nothing when someone stands perfectly straight, and an
 * interval of zero width would claim a precision no landmark detector has.
 */
const NOISE_FLOOR_DEG = 0.5;

const DEG = 180 / Math.PI;

const unusable = (reason: string): StandingCalibration => ({
  pitchDeg: 0,
  pitchRangeDeg: [-90, 90],
  standingBendM: 0,
  samples: 0,
  usable: false,
  reason,
});

/** Mean movement of the joints two frames share. */
const motionBetween = (
  previous: WorldObservationFrame,
  current: WorldObservationFrame
): number => {
  let total = 0;
  let count = 0;
  for (const [name, observed] of Object.entries(current.joints)) {
    const before = previous.joints[name as ClarityJoint];
    if (!before || !observed) continue;
    const a = observed.position;
    const b = before.position;
    total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    count += 1;
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export const calibrateFromStandingShot = (
  camera: CameraObservationSequence,
  options: StandingShotOptions = {}
): StandingCalibration => {
  const stillnessThresholdM = options.stillnessThresholdM ?? DEFAULTS.stillnessThresholdM;
  const maxBendM = options.maxBendM ?? DEFAULTS.maxBendM;
  const minSamples = options.minSamples ?? DEFAULTS.minSamples;

  /*
   * Anchored with NO pitch correction, deliberately. The whole job is to
   * measure the pitch, and starting from a world that has already had one
   * guessed into it would measure the guess.
   */
  const frames = anchorSequence(camera).frames;
  if (frames.length < 2) return unusable("the shot is too short to measure anything");

  // Still: not walking, not shifting. A standing shot that is not still is a
  // short clip of someone moving, and averaging that means nothing.
  const still: WorldObservationFrame[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    if (!frames[index].detected) continue;
    if (motionBetween(frames[index - 1], frames[index]) <= stillnessThresholdM) {
      still.push(frames[index]);
    }
  }
  if (still.length < minSamples) {
    return unusable(
      `only ${still.length} still frames -- the golfer needs to stand without moving for about a second`
    );
  }

  // And planted, for the same reason the swing clip needs it.
  const planted = plantedIndices(still.map(lookupFrom)).map((index) => still[index]);
  if (planted.length < minSamples) {
    return unusable(`only ${planted.length} frames had the golfer standing on both feet`);
  }

  const raw: number[] = [];
  const corrected: number[] = [];
  const bends: number[] = [];

  for (const frame of planted) {
    const shape = postureShape(frame);
    if (shape.samples.length < 3) continue;
    const hipHeightM = foreAftProfile(frame).find((sample) => sample.name === "hip")?.heightM;
    if (!hipHeightM || hipHeightM < 0.3) continue;

    raw.push(shape.apparentLeanDeg);
    corrected.push(shape.apparentLeanDeg - Math.atan(shape.hipSetBackM / hipHeightM) * DEG);
    bends.push(shape.hipSetBackM);
  }

  if (raw.length < minSamples) {
    return unusable(`only ${raw.length} frames gave a full enough body to measure`);
  }

  const standingBendM = median(bends);
  const rawDeg = median(raw);
  const correctedDeg = median(corrected);

  const low = Math.min(rawDeg, correctedDeg) - NOISE_FLOOR_DEG;
  const high = Math.max(rawDeg, correctedDeg) + NOISE_FLOOR_DEG;
  const bracket: readonly [number, number] = [low, high];

  if (Math.abs(standingBendM) > maxBendM) {
    return {
      pitchDeg: (low + high) / 2,
      pitchRangeDeg: bracket,
      standingBendM,
      samples: raw.length,
      usable: false,
      reason: `they stood ${(standingBendM * 1000).toFixed(0)}mm off a plumb line, which is a crouch rather than a stand -- the two estimators are ${Math.abs(rawDeg - correctedDeg).toFixed(1)}° apart`,
    };
  }

  return {
    pitchDeg: (low + high) / 2,
    pitchRangeDeg: bracket,
    standingBendM,
    samples: raw.length,
    usable: true,
    reason: null,
  };
};
