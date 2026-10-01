// image pixels --(surface calibration)--> world plane (mm) --(practice target)--> target plane (mm)
//
// The surface calibration is physical: it changes only when the camera is set
// up again. The practice target is a software choice: the aim can swing about
// the ball as often as the coach likes and nothing is recalibrated. Samples are
// stored in WORLD coordinates so a putt can be re-read against any aim.

import { apply3, degrees, radians, Vec2, wrapAngle, type Mat3 } from "./geometry";
import type { DeviceAttitude } from "./motion";

export type SurfaceCalibration = {
  imageToWorld: Mat3;
  worldToImage: Mat3;
  imageWidth: number;
  imageHeight: number;
  /** The calibrated ball centre: the world origin by construction. */
  ballOrigin: Vec2;
  mmPerPixelAtBall: number;
  /** RMS residual of the template references after the solve, mm. */
  reprojectionErrorMM: number;
  referenceCount: number;
  /** 0..1 */
  confidence: number;
  attitude: DeviceAttitude | null;
  timestamp: number;
};

/** Two virtual pegs straddling the aim line `distance` mm out, `width` mm apart. */
export type PracticeGate = { distance: number; width: number };

/** The virtual aim: a rotation of the target line about the calibrated ball. */
export type PracticeTarget = {
  /** Radians, positive = aim right of the physical calibration line. */
  aimOffset: number;
  gates: PracticeGate[];
};

export const defaultTarget = (): PracticeTarget => ({ aimOffset: 0, gates: [] });
export const aimDegrees = (t: PracticeTarget) => degrees(t.aimOffset);
export const withAimDegrees = (t: PracticeTarget, deg: number): PracticeTarget => ({ ...t, aimOffset: radians(deg) });

export class PuttingCoordinateSystem {
  constructor(
    public surface: SurfaceCalibration,
    public target: PracticeTarget,
  ) {}

  worldFromImage(p: Vec2) {
    return apply3(this.surface.imageToWorld, p);
  }
  imageFromWorld(p: Vec2) {
    return apply3(this.surface.worldToImage, p);
  }

  /** Unit vector of the current aim line, world coordinates. */
  get aimDirection() {
    return Vec2.direction(this.target.aimOffset);
  }

  /** The target frame keeps the ball at its origin and turns the aim line onto +y. */
  targetFromWorld(p: Vec2) {
    return p.sub(this.surface.ballOrigin).rotated(this.target.aimOffset);
  }
  worldFromTarget(p: Vec2) {
    return p.rotated(-this.target.aimOffset).add(this.surface.ballOrigin);
  }
  targetAngle(worldAngle: number) {
    return wrapAngle(worldAngle - this.target.aimOffset);
  }
}
