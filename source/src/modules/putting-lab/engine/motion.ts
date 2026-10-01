// What the motion sensors say about the phone, reduced to what the lab uses.
// Setup help and a tripwire only: the measurement frame comes from the
// template, never from the sensors.

import { radians } from "./geometry";

export type Vec3 = { x: number; y: number; z: number };

export type DeviceAttitude = {
  /** Unit quaternion of the device attitude. */
  w: number;
  x: number;
  y: number;
  z: number;
  /** Gravity in the device frame (any consistent scale and sign). */
  gravity: Vec3;
};

export function attitudeAngle(a: DeviceAttitude, b: DeviceAttitude) {
  const d = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
  return 2 * Math.acos(Math.min(1, d));
}

/**
 * How far the camera's axis is from vertical, radians. Uses |z| so it does
 * not care which way a browser signs gravity.
 */
export function cameraTilt(a: DeviceAttitude) {
  const g = a.gravity;
  const l = Math.hypot(g.x, g.y, g.z);
  if (l <= 0) return 0;
  return Math.acos(Math.min(1, Math.abs(g.z) / l));
}

export function vectorAngle(a: Vec3, b: Vec3) {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (la <= 0 || lb <= 0) return 0;
  return Math.acos(Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb))));
}

export type CameraLevel = "good" | "tilted" | "tooSteep";
export type CameraMovement = "still" | "nudged" | "moved";

export const MOTION_LIMITS = {
  tiltWarning: radians(12),
  tiltLimit: radians(30),
  nudge: radians(0.25),
  moved: radians(0.6),
  /** Rotation within one second that counts as being moved rather than drift. */
  activeRotation: radians(0.08),
};

export function cameraLevel(a: DeviceAttitude): CameraLevel {
  const t = cameraTilt(a);
  if (t > MOTION_LIMITS.tiltLimit) return "tooSteep";
  if (t > MOTION_LIMITS.tiltWarning) return "tilted";
  return "good";
}

function classify(angle: number): CameraMovement {
  if (angle > MOTION_LIMITS.moved) return "moved";
  if (angle > MOTION_LIMITS.nudge) return "nudged";
  return "still";
}

/**
 * Movement since calibration, robust to sensor drift. A fused heading creeps
 * on its own, so tilt is read from gravity (which does not drift) and
 * rotation is only counted while the phone is actually turning.
 */
export class CameraMovementTracker {
  private history: Array<{ t: number; attitude: DeviceAttitude }>;
  accumulated = 0;

  constructor(
    readonly reference: DeviceAttitude,
    t: number,
  ) {
    this.history = [{ t, attitude: reference }];
  }

  update(attitude: DeviceAttitude, t: number): CameraMovement {
    const previous = this.history[this.history.length - 1]?.attitude;
    const secondAgo = this.history.find((h) => h.t >= t - 1)?.attitude;
    if (previous && secondAgo && attitudeAngle(secondAgo, attitude) > MOTION_LIMITS.activeRotation) {
      this.accumulated += attitudeAngle(previous, attitude);
    }
    this.history.push({ t, attitude });
    this.history = this.history.filter((h) => h.t >= t - 1.2);
    const tilt = vectorAngle(this.reference.gravity, attitude.gravity);
    return classify(Math.max(tilt, this.accumulated));
  }
}

/** W3C deviceorientation (alpha, beta, gamma in degrees, Z-X'-Y'') -> quaternion. */
export function quaternionFromEuler(alpha: number, beta: number, gamma: number) {
  const z = radians(alpha) / 2;
  const x = radians(beta) / 2;
  const y = radians(gamma) / 2;
  const cX = Math.cos(x);
  const cY = Math.cos(y);
  const cZ = Math.cos(z);
  const sX = Math.sin(x);
  const sY = Math.sin(y);
  const sZ = Math.sin(z);
  return {
    w: cX * cY * cZ - sX * sY * sZ,
    x: sX * cY * cZ - cX * sY * sZ,
    y: cX * sY * cZ + sX * cY * sZ,
    z: cX * cY * sZ + sX * sY * cZ,
  };
}
