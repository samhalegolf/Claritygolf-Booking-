/**
 * Levelling the world against the falling-over boundary.
 *
 * WHAT THE BOUNDARY IS
 *
 * A person standing on both feet has their centre of mass over those feet.
 * Past the toes, or behind the heels, they are not standing -- they are
 * falling. That edge is the FALLING-OVER BOUNDARY, and it is physics rather
 * than technique: it says nothing about how a golfer should address the ball,
 * only that they were still on their feet while being filmed.
 *
 * WHY IT IS THE ONLY THING THAT SEES A PITCHED CAMERA
 *
 * `observe/anchor` levels the world from the line between two flat feet,
 * which is horizontal. One line gives one constraint: it fixes the ROLL and
 * is blind to the PITCH, because a rotation about that same line leaves it
 * exactly where it was.
 *
 * The cost of that blindness is concentrated in one number. The mass centre
 * sits about 920mm above the ankles and the foot is about 265mm long, so one
 * degree of pitch slides the heel-to-toe reading by 16mm -- six percent of
 * the foot -- with nothing in the picture looking wrong. Five degrees put the
 * fixture's mass at 109% of its foot: a golfer mid-topple, holding the pose.
 *
 * So the boundary is the evidence. When the mass lands outside it the scene
 * is not unlikely, it is impossible, and the smallest pitch that brings the
 * mass back onto the boundary is a hard lower bound on the camera's tilt.
 *
 * WHY THIS NEEDS TWO PASSES
 *
 * The evidence for the pitch is the mass model, which needs a reconstructed
 * body, which needs an anchored sequence -- and the anchoring is what the
 * pitch has to go into. The dependency genuinely is a loop, so it is run as
 * a loop and not disguised as anything else: reconstruct, ask the boundary,
 * re-anchor with the answer, reconstruct again.
 *
 * Twice is enough, and a third pass is not run, because the correction is
 * derived from the mass position and applying it moves the mass position to
 * the boundary BY CONSTRUCTION. A second ask has nothing left to find, and
 * iterating would only chase detector noise around the edge of the foot.
 *
 * WHY THE CORRECTION GOES IN AT THE ANCHOR AND NOT ON THE OUTPUT
 *
 * Rotating the finished frames would leave the feet hanging off the ground:
 * the grounding, the contact alignment and the origin were all computed in
 * the old frame. Feeding the angle to `anchorSequence` instead means every
 * one of those steps re-runs in the corrected frame for free.
 *
 * WHAT THIS DOES NOT CLAIM
 *
 * The correction is a LOWER BOUND, not a solution. A camera tilted five
 * degrees is only caught out by 1.6, because the reading has to travel all
 * the way past the toes before it becomes impossible at all. What comes back
 * is a scene that is no longer impossible. It is not thereby right, and
 * `anchor.pitchCorrectionDeg` is on the record so nobody has to guess whether
 * something was done to it.
 */

import type { CameraObservationSequence } from "../../observe/observation";
import { anchorSequence, type AnchorOptions } from "../../observe/anchor";
import { checkableBodies, checkMassAgainstShape } from "../mass/massSanity";
import { reconstruct, type ReconstructionReport, type ReconstructOptions } from "./reconstruct";

export interface LevelledOptions {
  readonly anchor?: AnchorOptions;
  readonly reconstruct?: ReconstructOptions;
  /**
   * Leave the world where the stance line put it and only report what the
   * boundary implies.
   *
   * For comparing the two side by side, and for anyone who would rather have
   * a scene that is wrong in a way they can predict than one that has been
   * quietly rotated underneath them.
   */
  readonly reportOnly?: boolean;
}

export interface LevelledResult extends ReconstructionReport {
  /** Degrees of pitch the boundary forced. Zero when the clip never reached it. */
  readonly pitchCorrectionDeg: number;
  /** True when a second pass was run, i.e. the correction is in the coordinates. */
  readonly corrected: boolean;
}

/** Below this the correction is smaller than the measurement, so it is noise. */
const WORTH_APPLYING_DEG = 0.05;

export const reconstructLevelled = (
  camera: CameraObservationSequence,
  options: LevelledOptions = {}
): LevelledResult => {
  const first = reconstruct(anchorSequence(camera, options.anchor), options.reconstruct);

  const checkable = checkableBodies(first.sequence.frames);
  const sanity = checkable.length > 0 ? checkMassAgainstShape(checkable) : null;
  const pitchCorrectionDeg = sanity?.fallingOverPitchDeg ?? 0;

  if (options.reportOnly || Math.abs(pitchCorrectionDeg) < WORTH_APPLYING_DEG) {
    return { ...first, pitchCorrectionDeg, corrected: false };
  }

  /*
   * The sign. `fallingOverPitchDeg` is the camera's tilt as the boundary sees
   * it; undoing it means turning the world the other way, so the angle handed
   * to the anchor is negated.
   */
  const second = reconstruct(
    anchorSequence(camera, {
      ...options.anchor,
      pitchCorrectionDeg: -pitchCorrectionDeg,
      pitchCorrectionSource: "falling-over-boundary",
    }),
    options.reconstruct
  );

  return { ...second, pitchCorrectionDeg, corrected: true };
};
