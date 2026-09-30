/**
 * Turning one clip's observations into the two sequences the lab shows, with
 * a standing shot folded in when there is one.
 *
 * WHY THIS IS NOT IN THE HOOK
 *
 * It is the only part of the video path that makes decisions, and a React
 * hook cannot be tested by the runner this project uses. Everything left in
 * `useVideoObservation` is state plumbing: which clip is being detected, what
 * survives a new file, when to rebuild. The judgement lives here, where it
 * can be checked against a known body.
 *
 * WHY IT REBUILDS RATHER THAN PATCHES
 *
 * The two clips arrive in either order and either can be replaced. Detection
 * is the expensive step -- tens of milliseconds a frame -- and this is not;
 * it is a few reconstructions over data already in memory. So every change
 * rebuilds from both sets of observations rather than trying to adjust the
 * previous answer, which is how "drop the standing shot" gets to return the
 * EXACT result you would have had without one, rather than something close.
 */

import type { ClaritySequence } from "../contracts";
import { fuseTwoViews, type TwoViewReport } from "../motion/fuse/twoView";
import { reconstructCalibrated, type CalibratedResult } from "../motion/level/calibrated";
import type { NeutralFarSideReport } from "../motion/reconstruct/neutralFarSide";
import type { StandingCalibration } from "../motion/level/standingShot";
import { passthroughSequence } from "../motion/passthrough";
import type {
  CameraObservationSequence,
  WorldObservationSequence,
} from "../observe/observation";

/** What the levelling decided, flattened for the readout. */
export interface LevellingReadout {
  readonly pitchCorrectionDeg: number;
  readonly source: CalibratedResult["source"];
  readonly agreement: CalibratedResult["agreement"];
  readonly boundaryResidualDeg: number;
  readonly boundaryRangeDeg: readonly [number, number];
  readonly calibrationWithinBoundary: boolean;
  /** Down the line, the far leg's zero point. Null when the stage was off. */
  readonly neutral: NeutralFarSideReport | null;
}

export interface VideoSequences {
  /** The naive baseline: what the detector said, holes left as holes. */
  readonly sequence: ClaritySequence;
  /** The same observations through the full Motion Layer, levelled. */
  readonly reconstructed: ClaritySequence;
  readonly levelling: LevellingReadout;
  /** The standing shot's verdict, when one was supplied. */
  readonly calibration: StandingCalibration | null;
  /** What putting the second angle together with the swing found. Null with no second angle. */
  readonly fusion: TwoViewReport | null;
}

/** The observations of one swing: both spaces, as `observeVideo` returns them. */
export interface SwingObservations {
  readonly camera: CameraObservationSequence;
  readonly world: WorldObservationSequence;
}

export const buildVideoSequences = (
  swing: SwingObservations,
  standing: CameraObservationSequence | null,
  secondAngle: CameraObservationSequence | null = null
): VideoSequences => {
  /*
   * A second angle of the same swing replaces the swing's 3D lift with both
   * cameras' agreement, on the swing's own timeline and pixels. Everything
   * after it -- levelling, the standing shot, the Motion Layer -- runs on the
   * fused clip exactly as on one. See `motion/fuse/twoView`.
   */
  const fusion = secondAngle ? fuseTwoViews(swing.camera, secondAngle) : null;
  const fused = fusion?.report.usable ?? false;
  const built = reconstructCalibrated(fusion?.sequence ?? swing.camera, standing, {
    /*
     * Zeroing the far leg's depth exists because, down the line, nothing
     * could see along the target line. With a second camera something can,
     * and zeroing would throw that measurement away.
     */
    reconstruct: fused ? { stages: { neutralFarSide: false } } : undefined,
  });

  return {
    /*
     * The passthrough is deliberately NOT levelled.
     *
     * Its whole job is to show what arrives with nothing done to it, so that
     * the Motion Layer beside it can be judged. Quietly rotating its world
     * would make the comparison a lie -- and it is the comparison, not the
     * baseline itself, that anyone is looking at. For the same reason it is
     * the on-screen clip alone, with no second angle folded in.
     */
    sequence: passthroughSequence(swing.world),
    reconstructed: built.sequence,
    levelling: {
      pitchCorrectionDeg: built.pitchCorrectionDeg,
      source: built.source,
      agreement: built.agreement,
      boundaryResidualDeg: built.boundaryResidualDeg,
      boundaryRangeDeg: built.boundaryRangeDeg,
      calibrationWithinBoundary: built.calibrationWithinBoundary,
      neutral: built.neutral,
    },
    calibration: built.calibration,
    fusion: fusion?.report ?? null,
  };
};
