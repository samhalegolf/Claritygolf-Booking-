/**
 * The two routes to a levelled world, and what happens when they disagree.
 *
 * ROUTE ONE: the falling-over boundary, always available.
 *
 * Costs nothing and needs no cooperation from the golfer, because the
 * evidence is already in the swing: a person standing on both feet has their
 * mass over those feet. It is a hard LOWER BOUND, and often a loose one --
 * five degrees of tilt is caught out by 1.6, and a clip whose mass never
 * nears the edge of the foot proves nothing at all.
 *
 * ROUTE TWO: a standing shot, when there is one.
 *
 * Costs two seconds of the golfer's time and gives roughly a degree, because
 * a standing body is nearly a plumb line and its fore-aft slope is nearly the
 * camera's. See `standingShot`.
 *
 * WHY THEY ARE NOT AVERAGED
 *
 * They are not two noisy measurements of the same thing. The boundary is a
 * BOUND -- the true pitch is at least this much -- and the standing shot is an
 * ESTIMATE. Averaging a bound with an estimate produces a number that is
 * neither, and quietly throws away the one guarantee in the system.
 *
 * So the standing shot is applied, and then the boundary is asked again of
 * the corrected world. If it still forces more pitch, the standing shot
 * under-estimated: physics wins, the residual goes on top, and the
 * disagreement is reported rather than smoothed over. A standing shot and a
 * swing that do not agree is a fact worth seeing -- most likely they were
 * filmed from different places, which no amount of arithmetic can fix.
 *
 * THE BLIND SPOT, STATED PLAINLY
 *
 * The cross-check is ONE-SIDED. It catches a standing shot that corrected too
 * little, because too little leaves the mass out past the toes where it
 * cannot be. It cannot catch one that corrected too MUCH, because
 * over-correcting drags the mass back toward the heels -- deeper inside the
 * foot, where nothing is violated.
 *
 * Measured: a standing shot filmed at ten degrees applied to a swing filmed
 * level gives a mean joint error of 152mm, against 5.7mm for doing nothing,
 * and every check in this file passes. The mass lands at 15% of the foot,
 * which is odd but perfectly possible.
 *
 * There is no geometric fix, because the camera genuinely moved between the
 * two shots and no arrangement of the pixels says so. What IS reported is
 * `boundaryRangeDeg` -- the pitches the swing itself admits -- so a
 * calibration sitting against the edge of that range is visible as a
 * calibration to be suspicious of. Beyond that it is an operational matter:
 * film both from the same place, and check the readout.
 */

import type { CameraObservationSequence } from "../../observe/observation";
import { anchorSequence } from "../../observe/anchor";
import { checkableBodies, checkMassAgainstShape } from "../mass/massSanity";
import { reconstruct } from "../reconstruct/reconstruct";
import { reconstructLevelled, type LevelledOptions, type LevelledResult } from "../reconstruct/levelled";
import {
  calibrateFromStandingShot,
  type StandingCalibration,
  type StandingShotOptions,
} from "./standingShot";

export interface CalibratedResult extends LevelledResult {
  /** Where the applied pitch came from. */
  readonly source: "standing-shot" | "falling-over-boundary" | "none";
  /** What the standing shot said, when one was given. */
  readonly calibration: StandingCalibration | null;
  /**
   * Degrees of pitch the falling-over boundary STILL forced after the standing
   * shot's correction was applied. Non-zero means the two disagree, and that
   * the standing shot was the one that was wrong -- the boundary is physics.
   */
  readonly boundaryResidualDeg: number;
  /**
   * The pitches the SWING clip admits on its own, degrees -- everything that
   * keeps the golfer's mass over their feet.
   *
   * Reported beside the calibration so the two can be eyeballed together. A
   * calibration in the middle of this range is corroborated; one pressed
   * against an edge is the shape of a camera that moved between shots, which
   * nothing here can prove and only this can hint at.
   */
  readonly boundaryRangeDeg: readonly [number, number];
  /** False when the standing shot claims a pitch the swing says is impossible. */
  readonly calibrationWithinBoundary: boolean;
  readonly agreement: "agree" | "boundary-forced-more" | "unchecked";
}

export interface CalibratedOptions extends LevelledOptions {
  readonly standingShot?: StandingShotOptions;
}

export const reconstructCalibrated = (
  swing: CameraObservationSequence,
  standing: CameraObservationSequence | null,
  options: CalibratedOptions = {}
): CalibratedResult => {
  const calibration = standing
    ? calibrateFromStandingShot(standing, options.standingShot)
    : null;

  /*
   * The swing's own admissible range, measured before anything is applied.
   * It is the only independent opinion available about the calibration.
   */
  const plain = reconstruct(anchorSequence(swing, options.anchor), options.reconstruct);
  const plainBodies = checkableBodies(plain.sequence.frames);
  const boundaryRangeDeg: readonly [number, number] =
    plainBodies.length > 0 ? checkMassAgainstShape(plainBodies).pitchRangeDeg : [-90, 90];

  const withinBoundary = (degrees: number) =>
    degrees >= boundaryRangeDeg[0] - 0.01 && degrees <= boundaryRangeDeg[1] + 0.01;

  // No usable standing shot: fall back to what the swing can prove on its own.
  if (!calibration?.usable || options.reportOnly) {
    const levelled = reconstructLevelled(swing, options);
    return {
      ...levelled,
      source: levelled.corrected ? "falling-over-boundary" : "none",
      calibration,
      boundaryResidualDeg: 0,
      boundaryRangeDeg,
      calibrationWithinBoundary: calibration ? withinBoundary(calibration.pitchDeg) : true,
      agreement: "unchecked",
    };
  }

  const applied = reconstruct(
    anchorSequence(swing, {
      ...options.anchor,
      // Same sign, not the opposite: see the note in `reconstruct/levelled`.
      // Positive means the camera leaned the golfer toward their toes, and
      // the anchor's rotation tips the body back toward the heels.
      pitchCorrectionDeg: calibration.pitchDeg,
      pitchCorrectionSource: "standing-shot",
    }),
    options.reconstruct
  );

  /*
   * Ask the boundary of the CORRECTED world. Anything it still forces is a
   * pitch the standing shot missed, and it is not negotiable.
   */
  const checkable = checkableBodies(applied.sequence.frames);
  const residual =
    checkable.length > 0 ? checkMassAgainstShape(checkable).fallingOverPitchDeg : 0;

  if (Math.abs(residual) < 0.05) {
    return {
      ...applied,
      pitchCorrectionDeg: calibration.pitchDeg,
      corrected: true,
      source: "standing-shot",
      calibration,
      boundaryResidualDeg: 0,
      boundaryRangeDeg,
      calibrationWithinBoundary: withinBoundary(calibration.pitchDeg),
      agreement: "agree",
    };
  }

  const total = calibration.pitchDeg + residual;
  const both = reconstruct(
    anchorSequence(swing, {
      ...options.anchor,
      pitchCorrectionDeg: total,
      pitchCorrectionSource: "standing-shot",
    }),
    options.reconstruct
  );

  return {
    ...both,
    pitchCorrectionDeg: total,
    corrected: true,
    source: "standing-shot",
    calibration,
    boundaryResidualDeg: residual,
    boundaryRangeDeg,
    calibrationWithinBoundary: withinBoundary(calibration.pitchDeg),
    agreement: "boundary-forced-more",
  };
};
