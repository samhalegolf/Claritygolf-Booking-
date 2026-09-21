/**
 * Cameras.
 *
 * The presets are named for golf but defined against the world frame's
 * MEASURED axes -- the stance line through the two feet -- rather than
 * against an assumed target direction. See `contracts/units.ts`: the video
 * never tells us where the target is, so "face-on" here means "looking at the
 * front of the stance", not "looking at someone aiming somewhere".
 *
 * This is also the point of the whole exercise. The 3D Space exists so
 * movement can be viewed from angles the original video never had.
 *
 * The orbit control is hand-written rather than pulled from three's addons:
 * it is about sixty lines, and owning it means preset changes can be ANIMATED
 * into rather than snapped to, which matters when the viewer is trying to
 * keep track of which way a body is facing.
 */

import { PerspectiveCamera, Spherical, Vector3 } from "three";

export type CameraPreset = "face-on" | "down-the-line" | "top" | "free";

export const CAMERA_PRESETS: readonly { key: CameraPreset; label: string; hint: string }[] = [
  { key: "face-on", label: "Face-on", hint: "Square to the stance line, looking at the front of the body." },
  { key: "down-the-line", label: "Down the line", hint: "Along the stance line from behind the trail side." },
  { key: "top", label: "Top", hint: "Straight down. The view no camera on a range ever has." },
  { key: "free", label: "Free", hint: "Drag to orbit, scroll to zoom, right-drag to pan." },
];

interface Placement {
  readonly position: Vector3;
  readonly target: Vector3;
}

/**
 * Where each preset sits, for a body of the given height standing at the
 * origin with the ball in front of it.
 *
 * World frame: +X toward the trail foot, +Y up, +Z the way the toes point.
 */
const placementFor = (preset: CameraPreset, heightM: number, ballZ: number): Placement => {
  const eye = heightM * 0.62;
  const target = new Vector3(0, heightM * 0.5, ballZ * 0.35);
  const distance = Math.max(3.2, heightM * 2.1);

  switch (preset) {
    case "face-on":
      // In front of the golfer, square to the stance.
      return { position: new Vector3(0, eye, ballZ + distance), target };
    case "down-the-line":
      // Behind the trail side, looking along the stance line. Lifted a little
      // so the body does not hide its own far side.
      return {
        position: new Vector3(distance * 0.95, eye * 1.25, ballZ - distance * 0.28),
        target,
      };
    case "top":
      return {
        position: new Vector3(0, distance * 1.45, ballZ * 0.3 + 0.01),
        target: new Vector3(0, 0, ballZ * 0.3),
      };
    case "free":
      // A three-quarter view that reads as neither of the standard two, so it
      // is obvious the camera is now free.
      return {
        position: new Vector3(distance * 0.75, eye * 1.5, ballZ + distance * 0.7),
        target,
      };
  }
};

export class CameraRig {
  readonly camera: PerspectiveCamera;

  private readonly target = new Vector3();
  private readonly spherical = new Spherical();

  private desiredPosition = new Vector3();
  private desiredTarget = new Vector3();

  /** 0..1 progress of the current preset transition. 1 means settled. */
  private transition = 1;
  private fromPosition = new Vector3();
  private fromTarget = new Vector3();

  private heightM = 1.8;
  private ballZ = 0.85;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(42, aspect, 0.05, 200);
    this.applyPreset("face-on", true);
  }

  setSubject(heightM: number, ballZ: number) {
    this.heightM = heightM;
    this.ballZ = ballZ;
  }

  applyPreset(preset: CameraPreset, immediate = false) {
    const placement = placementFor(preset, this.heightM, this.ballZ);
    this.desiredPosition.copy(placement.position);
    this.desiredTarget.copy(placement.target);

    if (immediate) {
      this.camera.position.copy(this.desiredPosition);
      this.target.copy(this.desiredTarget);
      this.transition = 1;
      this.syncSpherical();
      this.camera.lookAt(this.target);
      return;
    }

    this.fromPosition.copy(this.camera.position);
    this.fromTarget.copy(this.target);
    this.transition = 0;
  }

  /** Advance any in-flight preset transition. Returns true while still moving. */
  update(deltaSeconds: number): boolean {
    if (this.transition >= 1) return false;

    // ~0.55s to settle. Smootherstep so it neither jerks away nor drifts.
    this.transition = Math.min(1, this.transition + deltaSeconds / 0.55);
    const t = this.transition;
    const eased = t * t * t * (t * (t * 6 - 15) + 10);

    this.camera.position.lerpVectors(this.fromPosition, this.desiredPosition, eased);
    this.target.lerpVectors(this.fromTarget, this.desiredTarget, eased);
    this.camera.lookAt(this.target);

    if (this.transition >= 1) this.syncSpherical();
    return true;
  }

  private syncSpherical() {
    this.spherical.setFromVector3(this.camera.position.clone().sub(this.target));
  }

  /** Free-camera orbit. Pixels in, radians out. */
  orbit(deltaX: number, deltaY: number) {
    this.stopTransition();
    this.spherical.theta -= deltaX * 0.005;
    this.spherical.phi -= deltaY * 0.005;
    // Stop just short of the poles, where the up-vector flips and the view rolls.
    this.spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.spherical.phi));
    this.commitSpherical();
  }

  dolly(scrollDelta: number) {
    this.stopTransition();
    this.spherical.radius = Math.max(
      0.8,
      Math.min(30, this.spherical.radius * Math.exp(scrollDelta * 0.0012))
    );
    this.commitSpherical();
  }

  /** Pan across the view plane. Pixels in, metres out, scaled by distance. */
  pan(deltaX: number, deltaY: number) {
    this.stopTransition();
    const scale = this.spherical.radius * 0.0018;
    const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const shift = right.multiplyScalar(-deltaX * scale).add(up.multiplyScalar(deltaY * scale));
    this.target.add(shift);
    this.commitSpherical();
  }

  private stopTransition() {
    if (this.transition < 1) {
      // Interrupting a fly-through leaves the camera wherever it is; the
      // spherical state has to be rebuilt from that or the first drag jumps.
      this.transition = 1;
      this.syncSpherical();
    }
  }

  private commitSpherical() {
    this.camera.position.copy(this.target).add(new Vector3().setFromSpherical(this.spherical));
    this.camera.lookAt(this.target);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
