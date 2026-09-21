/**
 * Vector and quaternion maths over the contract's own types.
 *
 * This lives in contracts/ rather than in a utils/ folder for a reason: every
 * layer is allowed to import contracts/, so putting the shared maths here
 * keeps the dependency rules in `boundary.test.ts` to a single sentence per
 * layer. The contract defines Vec3 and Quat, so it defines how to operate on
 * them.
 *
 * Everything is pure and allocation-returning. The renderer converts to
 * three.js objects at its own edge; nothing here knows three.js exists.
 */

import type { Quat, Vec3 } from "./units";

/* ----------------------------- scalars ----------------------------- */

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite ease, zero first derivative at both ends. */
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Quintic ease, zero first AND second derivative at both ends. */
export const smootherstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Map `value` from one range to another, clamped. */
export const remap = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number => {
  if (inMax === inMin) return outMin;
  return lerp(outMin, outMax, clamp((value - inMin) / (inMax - inMin), 0, 1));
};

/* ------------------------------ Vec3 ------------------------------- */

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const negate = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const lengthSq = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const distanceSq = (a: Vec3, b: Vec3): number => lengthSq(sub(a, b));

/** Normalise. A zero-length vector returns zero rather than NaN. */
export const normalise = (a: Vec3): Vec3 => {
  const len = length(a);
  return len < 1e-12 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
};

/** Rescale to an exact length. A zero-length vector cannot be rescaled. */
export const withLength = (a: Vec3, target: number): Vec3 => scale(normalise(a), target);

export const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

export const centroid = (points: readonly Vec3[]): Vec3 => {
  if (points.length === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / points.length, y / points.length, z / points.length];
};

/** Weighted mean. Weights summing to zero return the unweighted centroid. */
export const weightedCentroid = (
  points: readonly Vec3[],
  weights: readonly number[]
): Vec3 => {
  let total = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i += 1) {
    const w = weights[i] ?? 0;
    total += w;
    x += points[i][0] * w;
    y += points[i][1] * w;
    z += points[i][2] * w;
  }
  if (total < 1e-12) return centroid(points);
  return [x / total, y / total, z / total];
};

/** Drop to the ground plane, Y = 0. The Upper Mass Map's projection. */
export const projectToGround = (a: Vec3): Vec3 => [a[0], 0, a[2]];

/* ------------------------------ Quat ------------------------------- */

export const qIdentity = (): Quat => [0, 0, 0, 1];

export const qFromAxisAngle = (axis: Vec3, radians: number): Quat => {
  const [x, y, z] = normalise(axis);
  const half = radians / 2;
  const s = Math.sin(half);
  return [x * s, y * s, z * s, Math.cos(half)];
};

export const qMultiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export const qConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export const qNormalise = (q: Quat): Quat => {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return len < 1e-12 ? qIdentity() : [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
};

/** Rotate a vector by a quaternion. */
export const qRotate = (q: Quat, v: Vec3): Vec3 => {
  const [qx, qy, qz, qw] = q;
  // t = 2 * (q_vec x v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
};

/**
 * Intrinsic yaw (about Y), then pitch (about X), then roll (about Z).
 *
 * Yaw-first matters for a body model: rotation about the vertical is the
 * dominant motion, and applying it first keeps pitch and roll readable as
 * "lean" and "side-bend" rather than as a tangle.
 */
export const qFromYawPitchRoll = (yaw: number, pitch: number, roll: number): Quat =>
  qMultiply(
    qMultiply(qFromAxisAngle([0, 1, 0], yaw), qFromAxisAngle([1, 0, 0], pitch)),
    qFromAxisAngle([0, 0, 1], roll)
  );

/** Shortest-arc interpolation. Handles the double-cover sign flip. */
export const qSlerp = (a: Quat, b: Quat, t: number): Quat => {
  let cosHalf = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end: Quat = b;
  if (cosHalf < 0) {
    end = [-b[0], -b[1], -b[2], -b[3]];
    cosHalf = -cosHalf;
  }
  // Nearly parallel: lerp and renormalise, which is stable where slerp is not.
  if (cosHalf > 0.9995) {
    return qNormalise([
      lerp(a[0], end[0], t),
      lerp(a[1], end[1], t),
      lerp(a[2], end[2], t),
      lerp(a[3], end[3], t),
    ]);
  }
  const halfAngle = Math.acos(clamp(cosHalf, -1, 1));
  const sinHalf = Math.sin(halfAngle);
  const wa = Math.sin((1 - t) * halfAngle) / sinHalf;
  const wb = Math.sin(t * halfAngle) / sinHalf;
  return qNormalise([
    a[0] * wa + end[0] * wb,
    a[1] * wa + end[1] * wb,
    a[2] * wa + end[2] * wb,
    a[3] * wa + end[3] * wb,
  ]);
};

/** Angle between two orientations, radians. Used to measure correction. */
export const qAngleBetween = (a: Quat, b: Quat): number => {
  const cosHalf = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(clamp(cosHalf, -1, 1));
};

/**
 * The rotation that takes `from` onto `to`, both unit vectors.
 * Antiparallel inputs pick an arbitrary perpendicular axis, which is the
 * mathematically correct answer -- there is no unique shortest arc.
 */
export const qFromUnitVectors = (from: Vec3, to: Vec3): Quat => {
  const f = normalise(from);
  const t = normalise(to);
  const d = dot(f, t);
  if (d >= 1 - 1e-9) return qIdentity();
  if (d <= -1 + 1e-9) {
    const axis = Math.abs(f[0]) < 0.9 ? cross(f, [1, 0, 0]) : cross(f, [0, 1, 0]);
    return qFromAxisAngle(axis, Math.PI);
  }
  const axis = cross(f, t);
  return qNormalise([axis[0], axis[1], axis[2], 1 + d]);
};

/**
 * Build an orientation from a body's own axes.
 *
 * `right` and `up` need not be exactly perpendicular -- measured body axes
 * never are -- so `up` is re-derived from the orthogonalised basis.
 */
export const qFromBasis = (right: Vec3, up: Vec3): Quat => {
  const x = normalise(right);
  const z = normalise(cross(x, up));
  const y = cross(z, x);

  // Standard branch-by-largest-diagonal conversion. The branches exist to
  // keep the divisor away from zero; a single formula loses precision when
  // the trace is small.
  const m00 = x[0];
  const m10 = x[1];
  const m20 = x[2];
  const m01 = y[0];
  const m11 = y[1];
  const m21 = y[2];
  const m02 = z[0];
  const m12 = z[1];
  const m22 = z[2];
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return qNormalise([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return qNormalise([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return qNormalise([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return qNormalise([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]);
};

/* --------------------------- kinematics ---------------------------- */

/**
 * Place the middle joint of a two-bone chain.
 *
 * Elbows and knees are both this problem: the shoulder and wrist are known
 * (or estimated), the two bone lengths are known from the body model, and the
 * elbow is wherever those two circles intersect. The intersection is a circle
 * of solutions, so `pole` picks which one -- it is the direction the joint
 * bends toward.
 *
 * The chain is clamped rather than allowed to fail. When the endpoints are
 * further apart than the bones can reach, the limb straightens and the
 * overreach is reported, so a caller can tell "the arm is extended" from "the
 * observations are impossible". That distinction matters to the constraint
 * solver, which uses overreach as evidence that a detection is wrong.
 */
export interface TwoBoneSolution {
  /** Where the middle joint lands. */
  readonly joint: Vec3;
  /**
   * Metres by which the endpoints exceeded the chain's reach. Zero when the
   * pose is achievable; positive means the end position is not reachable and
   * the chain was straightened toward it.
   */
  readonly overreachM: number;
  /** Metres by which the endpoints were closer than the chain can fold. */
  readonly underreachM: number;
}

export const solveTwoBone = (
  start: Vec3,
  end: Vec3,
  startBoneLength: number,
  endBoneLength: number,
  pole: Vec3
): TwoBoneSolution => {
  const span = sub(end, start);
  const rawDistance = length(span);

  const maxReach = startBoneLength + endBoneLength;
  const minReach = Math.abs(startBoneLength - endBoneLength);
  const overreachM = Math.max(0, rawDistance - maxReach);
  const underreachM = Math.max(0, minReach - rawDistance);

  // Degenerate: coincident endpoints give no direction to build along.
  if (rawDistance < 1e-9) {
    const fallback = normalise(pole);
    return {
      joint: add(start, scale(fallback, startBoneLength)),
      overreachM,
      underreachM,
    };
  }

  // Epsilons keep the chain a hair away from fully straight or fully folded,
  // where the bend direction becomes undefined and the joint would snap.
  const clamped = clamp(rawDistance, minReach + 1e-6, maxReach - 1e-6);
  const along = scale(span, 1 / rawDistance);

  // Distance from `start` to the foot of the perpendicular through the joint.
  const projected =
    (clamped * clamped + startBoneLength * startBoneLength - endBoneLength * endBoneLength) /
    (2 * clamped);
  const height = Math.sqrt(Math.max(0, startBoneLength * startBoneLength - projected * projected));

  // Gram-Schmidt the pole against the chain axis so the bend is perpendicular.
  // A pole parallel to the axis leaves nothing to bend along, so pick any
  // perpendicular -- the joint has to go somewhere, and an arbitrary choice
  // beats a NaN.
  let bend = sub(pole, scale(along, dot(pole, along)));
  if (lengthSq(bend) < 1e-12) {
    const seed: Vec3 = Math.abs(along[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    bend = sub(seed, scale(along, dot(seed, along)));
  }

  return {
    joint: add(add(start, scale(along, projected)), scale(normalise(bend), height)),
    overreachM,
    underreachM,
  };
};
