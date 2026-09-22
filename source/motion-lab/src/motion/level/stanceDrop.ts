/**
 * The camera's own pitch, from the stance line's drop, for clips filmed
 * square to the stance.
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT A PITCH
 *
 * The line between a golfer's ankles is horizontal, so its drop down the
 * image says the world is not level. `observe/anchor` reads exactly that and
 * calls it the ROLL -- but it reads the angle as `atan2(dy, dx)`, which needs
 * the line to have some width across the image to measure against. Square to
 * the stance it has none, so the anchor declines.
 *
 * The drop itself is still there. What is missing is only the baseline to
 * divide it by, and that can come from the golfer's stature instead of from
 * the image: `asin(drop / stanceWidth)`.
 *
 * AND IT NEEDS ITS OWN AXIS TO BE APPLIED ABOUT.
 *
 * Three rotations get confused here, so they are worth naming together. The
 * levelling turns about the camera's DEPTH axis and undoes a camera roll.
 * `pitchCorrectionDeg` turns about the STANCE LINE and undoes a golfer
 * leaning fore-aft. What this measures turns about the camera's HORIZONTAL
 * axis, which square to the stance maps to the world's fore-aft axis --
 * neither of the other two.
 *
 * Both of the others were tried. Each made a 90mm error into 120-123mm, in
 * EITHER sign, which is what a wrong axis looks like rather than a wrong
 * direction. Given its own axis the same clip comes back to 7mm, at six,
 * ten or fifteen degrees of tilt alike.
 *
 * What it buys is real all the same: square to the stance the anchor cannot
 * level at all, so without this a down-the-line clip carries its tilt
 * uncorrected into every reading that compares a height against the ground.
 *
 * WHAT IT COSTS
 *
 * An angle needs a length to be measured over, and the one length this view
 * cannot measure is the stance width -- it lies along depth, which is the
 * axis a detector resolves worst. On a real clip it came back as 239mm where
 * the golfer's height says 365mm.
 *
 * So the width comes from the golfer's stature at a population ratio, and
 * that assumption is where most of the uncertainty lives. Dividing by the
 * compressed measurement instead is not a smaller error but a much larger
 * one: on that clip it turned a 6.1 degree pitch into 9.3, and the old
 * estimator then reported it as roll.
 */

import type { ClarityJoint } from "../../contracts";
import { lookupFrom, plantedIndices, type JointLookup } from "../../observe/foreAft";
import type { CameraObservationSequence } from "../../observe/observation";

export interface StanceDropCameraPitch {
  /**
   * The camera's own pitch, degrees -- a rotation about its horizontal axis.
   *
   * NOT the roll, and NOT the fore-aft pitch either. Those turn about the
   * camera's depth axis and about the stance line; this turns about the
   * camera's horizontal, which square to the stance is the world's fore-aft
   * axis. It is the only one of the three that can level a down-the-line
   * clip, and feeding this number to either of the others makes the
   * reconstruction worse in both signs.
   */
  readonly cameraPitchDeg: number;
  /** Half-width of the estimate, degrees. */
  readonly uncertaintyDeg: number;
  /**
   * How much of the stance lies along depth rather than across the image,
   * 0..1. Near one is square to the stance, which is where this works.
   */
  readonly alongDepthUnit: number;
  /** Planted frames the drop was taken over. */
  readonly samples: number;
  readonly usable: boolean;
  readonly reason: string | null;
}

export interface StanceDropOptions {
  /**
   * Stance width as a fraction of standing height. Population figure, stated
   * as one -- it is where most of this estimate's uncertainty comes from.
   */
  readonly stanceFractionOfHeight?: number;
  /**
   * How much of the stance must lie along depth before the drop is read as
   * pitch rather than roll.
   */
  readonly minAlongDepth?: number;
  readonly minSamples?: number;
}

const DEFAULTS = {
  stanceFractionOfHeight: 0.22,
  /*
   * Below this the stance still has enough across-image extent for the roll
   * to leak into the reading: the drop is `stance * (sin(pitch)*alongDepth +
   * sin(roll)*acrossImage)`, so whatever is not depth is a roll term. At 0.85
   * an unmeasured five degrees of roll biases the pitch by under half of one.
   */
  minAlongDepth: 0.85,
  minSamples: 10,
} as const;

/** How far a population stance width might be out, as a fraction. */
const STANCE_WIDTH_UNCERTAINTY = 0.2;

const DEG = 180 / Math.PI;

const unusable = (reason: string, alongDepthUnit = 0): StanceDropCameraPitch => ({
  cameraPitchDeg: 0,
  uncertaintyDeg: 90,
  alongDepthUnit,
  samples: 0,
  usable: false,
  reason,
});

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/*
 * THE ANKLES, AND ONLY THE ANKLES.
 *
 * The heels look like a free second opinion from different landmarks, and
 * they were used as one. They are not: golfers flare their feet, so the heels
 * sit closer together than the ankles -- 346mm against 396mm on this fixture
 * -- while the angle is computed against ONE assumed width. Feeding both
 * pairs through the same divisor made every reading 12% shallow, which is a
 * bias rather than noise and no amount of averaging would have shown it.
 *
 * The stance width a population ratio describes is ankle to ankle, so that is
 * the pair to measure.
 */
const PAIRS: readonly (readonly [ClarityJoint, ClarityJoint])[] = [
  ["leftAnkle", "rightAnkle"],
];

export const measureStanceDropCameraPitch = (
  camera: CameraObservationSequence,
  estimatedHeightM: number,
  options: StanceDropOptions = {}
): StanceDropCameraPitch => {
  const stanceFraction = options.stanceFractionOfHeight ?? DEFAULTS.stanceFractionOfHeight;
  const minAlongDepth = options.minAlongDepth ?? DEFAULTS.minAlongDepth;
  const minSamples = options.minSamples ?? DEFAULTS.minSamples;

  if (!(estimatedHeightM > 1) || !(estimatedHeightM < 2.6)) {
    return unusable("no usable stature to take a stance width from");
  }
  const stanceWidthM = estimatedHeightM * stanceFraction;

  /*
   * Measured on PLANTED frames only, and in CAMERA space.
   *
   * Planted because a lifting heel raises its own ankle, which is a drop that
   * has nothing to do with the camera. Camera space because the levelling has
   * not run yet -- and must not, since square to the stance it declines
   * anyway. Image vertical is image vertical either way; the yaw that world
   * space would add does not touch y.
   */
  const detected = camera.frames.filter((frame) => frame.detected);
  const lookups: JointLookup[] = detected.map((frame) => lookupFrom(frame as never));
  const planted = plantedIndices(lookups).map((index) => detected[index]);

  const drops: number[] = [];
  const alongDepth: number[] = [];

  for (const frame of planted) {
    for (const [leftJoint, rightJoint] of PAIRS) {
      const left = frame.joints[leftJoint];
      const right = frame.joints[rightJoint];
      if (!left || !right) continue;
      const dx = right.position[0] - left.position[0];
      const dy = right.position[1] - left.position[1];
      const dz = right.position[2] - left.position[2];
      const across = Math.hypot(dx, dz);
      if (across < 1e-3) continue;
      drops.push(dy);
      alongDepth.push(Math.abs(dz) / across);
    }
  }

  if (drops.length < minSamples) {
    return unusable(`only ${drops.length} planted frames to measure a drop over`);
  }

  const alongDepthUnit = median(alongDepth);
  if (alongDepthUnit < minAlongDepth) {
    return unusable(
      `the stance lies ${(alongDepthUnit * 100).toFixed(0)}% along depth -- too much of it is across the image, where this drop is the ROLL and the anchor already reads it`,
      alongDepthUnit
    );
  }

  const dropM = median(drops);
  const ratio = Math.max(-1, Math.min(1, dropM / stanceWidthM));
  /*
   * The sign is fixed by the world frame's handedness rather than by
   * argument, so it is pinned by a test that injects a known pitch and checks
   * the number comes back with the same sign and size.
   */
  const cameraPitchDeg = Math.asin(ratio) * DEG;

  /*
   * Where the uncertainty comes from, in order of size: the stance width is a
   * population figure and people vary; whatever is not along depth is a roll
   * term that cannot be removed without a roll; and the drop itself wobbles.
   */
  const fromWidth = Math.abs(cameraPitchDeg) * STANCE_WIDTH_UNCERTAINTY;
  const fromRoll = Math.sqrt(Math.max(0, 1 - alongDepthUnit * alongDepthUnit)) * 5;
  const sorted = [...drops].sort((a, b) => a - b);
  const spreadM = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
  const fromSpread = ((spreadM / stanceWidthM) * DEG) / Math.sqrt(drops.length);

  return {
    cameraPitchDeg,
    uncertaintyDeg: Math.hypot(fromWidth, fromRoll, fromSpread),
    alongDepthUnit,
    samples: drops.length,
    usable: true,
    reason: null,
  };
};
