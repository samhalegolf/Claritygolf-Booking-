/**
 * Maths tests.
 *
 * A wrong quaternion convention does not throw. It produces a body that is
 * subtly mirrored or rotated, which looks like a tracking problem and gets
 * debugged for hours in the wrong layer. These tests pin the conventions down
 * before anything is built on them.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  add,
  applyRigidFit,
  centroid,
  clamp,
  cross,
  distance,
  dot,
  fitRigidTransform,
  lerpVec,
  normalise,
  projectToGround,
  qAngleBetween,
  qFromAxisAngle,
  qFromBasis,
  qFromUnitVectors,
  qFromYawPitchRoll,
  qIdentity,
  qMultiply,
  qRotate,
  qSlerp,
  remap,
  scale,
  smootherstep,
  smoothstep,
  solveTwoBone,
  sub,
  weightedCentroid,
  withLength,
} from "./math";
import type { Quat, Vec3 } from "./units";

const closeTo = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );

const vecCloseTo = (actual: Vec3, expected: Vec3, tolerance = 1e-9) => {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `component ${i}: expected ${actual[i]} to be within ${tolerance} of ${expected[i]} ` +
        `(got [${actual.join(", ")}], wanted [${expected.join(", ")}])`
    );
  }
};

test("vector arithmetic", () => {
  vecCloseTo(add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  vecCloseTo(sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
  vecCloseTo(scale([1, 2, 3], 2), [2, 4, 6]);
  closeTo(dot([1, 0, 0], [0, 1, 0]), 0);
  closeTo(dot([1, 2, 3], [4, 5, 6]), 32);
  closeTo(distance([0, 0, 0], [3, 4, 0]), 5);
});

test("cross product is right-handed: X cross Y is +Z", () => {
  // This single assertion pins the handedness of the whole world. If it ever
  // flips, every reconstruction mirrors and the 3D view shows a left-handed
  // golfer swinging a right-handed swing.
  vecCloseTo(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  vecCloseTo(cross([0, 1, 0], [0, 0, 1]), [1, 0, 0]);
  vecCloseTo(cross([0, 0, 1], [1, 0, 0]), [0, 1, 0]);
});

test("normalise returns zero rather than NaN for a zero vector", () => {
  // A joint that has not been placed yet is the zero vector. Returning NaN
  // here would poison every downstream average silently.
  vecCloseTo(normalise([0, 0, 0]), [0, 0, 0]);
  vecCloseTo(withLength([0, 0, 0], 5), [0, 0, 0]);
  vecCloseTo(withLength([0, 3, 0], 5), [0, 5, 0]);
});

test("weightedCentroid falls back to the plain centroid when weights vanish", () => {
  const points: Vec3[] = [
    [0, 0, 0],
    [2, 0, 0],
  ];
  vecCloseTo(weightedCentroid(points, [0, 0]), centroid(points));
  vecCloseTo(weightedCentroid(points, [3, 1]), [0.5, 0, 0]);
});

test("projectToGround drops Y and keeps the ground position", () => {
  vecCloseTo(projectToGround([0.4, 1.3, -0.2]), [0.4, 0, -0.2]);
});

test("scalar helpers", () => {
  closeTo(clamp(5, 0, 1), 1);
  closeTo(clamp(-5, 0, 1), 0);
  closeTo(smoothstep(0), 0);
  closeTo(smoothstep(1), 1);
  closeTo(smoothstep(0.5), 0.5);
  closeTo(smootherstep(0.5), 0.5);
  closeTo(remap(5, 0, 10, 0, 100), 50);
  // Out-of-range inputs clamp rather than extrapolate.
  closeTo(remap(20, 0, 10, 0, 100), 100);
  // A degenerate input range cannot divide; it returns the low output.
  closeTo(remap(5, 3, 3, 7, 9), 7);
});

test("qRotate about Y takes +X to -Z at +90 degrees", () => {
  // Right-handed, Y-up: a positive rotation about Y turns +X toward -Z.
  const yaw90 = qFromAxisAngle([0, 1, 0], Math.PI / 2);
  vecCloseTo(qRotate(yaw90, [1, 0, 0]), [0, 0, -1], 1e-9);
  vecCloseTo(qRotate(yaw90, [0, 1, 0]), [0, 1, 0], 1e-9);
});

test("quaternion multiplication composes in apply-b-then-a order", () => {
  const yaw90 = qFromAxisAngle([0, 1, 0], Math.PI / 2);
  const composed = qMultiply(yaw90, yaw90);
  vecCloseTo(qRotate(composed, [1, 0, 0]), [-1, 0, 0], 1e-9);
});

test("qFromYawPitchRoll applies yaw about the vertical first", () => {
  const q = qFromYawPitchRoll(Math.PI / 2, 0, 0);
  vecCloseTo(qRotate(q, [1, 0, 0]), [0, 0, -1], 1e-9);

  // Pitch alone tips the forward axis downward about +X.
  const pitched = qFromYawPitchRoll(0, Math.PI / 2, 0);
  vecCloseTo(qRotate(pitched, [0, 1, 0]), [0, 0, 1], 1e-9);
});

test("qFromUnitVectors finds the rotation between two directions", () => {
  const q = qFromUnitVectors([1, 0, 0], [0, 1, 0]);
  vecCloseTo(qRotate(q, [1, 0, 0]), [0, 1, 0], 1e-9);

  // Identical inputs need no rotation.
  vecCloseTo(qRotate(qFromUnitVectors([0, 1, 0], [0, 1, 0]), [1, 0, 0]), [1, 0, 0], 1e-9);

  // Antiparallel: any perpendicular axis is correct, so assert the outcome
  // rather than the axis.
  const flipped = qFromUnitVectors([1, 0, 0], [-1, 0, 0]);
  vecCloseTo(qRotate(flipped, [1, 0, 0]), [-1, 0, 0], 1e-6);
});

test("qFromBasis reproduces the basis it was built from", () => {
  // The pelvis and thorax orientations are built this way from measured body
  // axes, so a round-trip failure here shows up as a twisted torso.
  const right = normalise([1, 0.2, 0]);
  const up = normalise([-0.1, 1, 0.05]);
  const q = qFromBasis(right, up);

  const rebuiltRight = qRotate(q, [1, 0, 0]);
  vecCloseTo(rebuiltRight, right, 1e-6);

  // The up axis is re-derived orthogonally, so it should be perpendicular to
  // right and still on the same side as the input.
  const rebuiltUp = qRotate(q, [0, 1, 0]);
  closeTo(dot(rebuiltRight, rebuiltUp), 0, 1e-6);
  assert.ok(dot(rebuiltUp, up) > 0.9, "rebuilt up should point the same way as the input");
});

test("qFromBasis stays stable through every diagonal branch", () => {
  // The conversion picks a branch by largest matrix diagonal; each branch is
  // a separate opportunity to get a sign wrong. Sweep orientations so every
  // branch is exercised.
  for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 7) {
    for (let pitch = -1.2; pitch <= 1.2; pitch += 0.4) {
      const source = qFromYawPitchRoll(yaw, pitch, 0);
      const right = qRotate(source, [1, 0, 0]);
      const up = qRotate(source, [0, 1, 0]);
      const rebuilt = qFromBasis(right, up);
      vecCloseTo(qRotate(rebuilt, [1, 0, 0]), right, 1e-6);
      vecCloseTo(qRotate(rebuilt, [0, 1, 0]), up, 1e-6);
    }
  }
});

test("qSlerp interpolates and handles the double-cover sign flip", () => {
  const a = qIdentity();
  const b = qFromAxisAngle([0, 1, 0], Math.PI / 2);

  vecCloseTo(qRotate(qSlerp(a, b, 0), [1, 0, 0]), [1, 0, 0], 1e-9);
  vecCloseTo(qRotate(qSlerp(a, b, 1), [1, 0, 0]), [0, 0, -1], 1e-9);

  const halfway = qSlerp(a, b, 0.5);
  closeTo(qAngleBetween(a, halfway), Math.PI / 4, 1e-6);

  // Negating a quaternion names the same rotation. Slerp must take the short
  // way round regardless, or the reconciliation of a returning observation
  // would occasionally spin the long way.
  const negated: Quat = [-b[0], -b[1], -b[2], -b[3]];
  const viaNegated = qSlerp(a, negated, 0.5);
  closeTo(qAngleBetween(halfway, viaNegated), 0, 1e-6);
});

test("qSlerp is stable for nearly-parallel orientations", () => {
  const a = qIdentity();
  const b = qFromAxisAngle([0, 1, 0], 1e-7);
  const mid = qSlerp(a, b, 0.5);
  assert.ok(Number.isFinite(mid[0] + mid[1] + mid[2] + mid[3]), "slerp produced NaN");
  closeTo(Math.hypot(mid[0], mid[1], mid[2], mid[3]), 1, 1e-9);
});

test("lerpVec moves linearly between endpoints", () => {
  vecCloseTo(lerpVec([0, 0, 0], [2, 4, 6], 0.5), [1, 2, 3]);
});

test("solveTwoBone places the joint on both circles", () => {
  const start: Vec3 = [0, 0, 0];
  const end: Vec3 = [1, 0, 0];
  const solution = solveTwoBone(start, end, 0.7, 0.7, [0, 1, 0]);

  closeTo(distance(start, solution.joint), 0.7, 1e-6);
  closeTo(distance(end, solution.joint), 0.7, 1e-6);
  closeTo(solution.overreachM, 0);
  closeTo(solution.underreachM, 0);
  // The pole decides which way it bends.
  assert.ok(solution.joint[1] > 0, "the joint should bend toward the pole");

  const flipped = solveTwoBone(start, end, 0.7, 0.7, [0, -1, 0]);
  assert.ok(flipped.joint[1] < 0, "flipping the pole should flip the bend");
});

test("solveTwoBone reports overreach instead of failing", () => {
  // The constraint solver uses this: endpoints further apart than the bones
  // can span are evidence that a detection is wrong, not a reason to produce
  // NaN.
  const solution = solveTwoBone([0, 0, 0], [3, 0, 0], 0.7, 0.7, [0, 1, 0]);
  closeTo(solution.overreachM, 3 - 1.4, 1e-9);
  assert.ok(Number.isFinite(solution.joint[0]), "overreach must not produce NaN");
  // Straightened: the joint sits on the line between the endpoints.
  closeTo(solution.joint[1], 0, 1e-3);
});

test("solveTwoBone reports underreach for an impossible fold", () => {
  const solution = solveTwoBone([0, 0, 0], [0.05, 0, 0], 1.0, 0.3, [0, 1, 0]);
  closeTo(solution.underreachM, 0.7 - 0.05, 1e-9);
  assert.ok(Number.isFinite(solution.joint[1]));
});

test("solveTwoBone survives coincident endpoints and a parallel pole", () => {
  const coincident = solveTwoBone([1, 1, 1], [1, 1, 1], 0.5, 0.5, [0, 1, 0]);
  assert.ok(Number.isFinite(coincident.joint[0] + coincident.joint[1] + coincident.joint[2]));
  closeTo(distance([1, 1, 1], coincident.joint), 0.5, 1e-6);

  // A pole lying along the chain axis leaves no perpendicular; the solver
  // must still place the joint somewhere real.
  const parallel = solveTwoBone([0, 0, 0], [1, 0, 0], 0.7, 0.7, [1, 0, 0]);
  assert.ok(Number.isFinite(parallel.joint[1]));
  closeTo(distance([0, 0, 0], parallel.joint), 0.7, 1e-6);
  closeTo(distance([1, 0, 0], parallel.joint), 0.7, 1e-6);
});

/* --------------------------- rigid fits ---------------------------- */

test("a rigid fit recovers the transform that made the data", () => {
  const rotation = qFromAxisAngle([0.3, 1, 0.2], 0.7);
  const translation: Vec3 = [0.4, -1.2, 0.25];
  const body: Vec3[] = [
    [-0.2, 0, 0],
    [0.2, 0, 0],
    [0, 0.21, 0.02],
    [0, -0.52, 0],
  ];
  const fit = fitRigidTransform(
    body.map((point) => ({
      from: point,
      to: add(qRotate(rotation, point), translation),
      weight: 1,
    }))
  );
  assert.ok(fit);
  for (const point of body) {
    const expected = add(qRotate(rotation, point), translation);
    assert.ok(
      distance(applyRigidFit(fit, point), expected) < 1e-6,
      `point came back ${(distance(applyRigidFit(fit, point), expected) * 1000).toFixed(3)}mm out`
    );
  }
});

test("a rigid fit leaves an undetermined rotation where the seed put it", () => {
  // One correspondence fixes the translation and says nothing about the
  // rotation. An arbitrary answer here would flip a body between frames for
  // want of evidence either way, so the seed has to survive untouched.
  const seed = qFromAxisAngle([0, 1, 0], 1.1);
  const fit = fitRigidTransform([{ from: [0.2, 0, 0], to: [1, 2, 3], weight: 1 }], seed);
  assert.ok(fit);
  assert.ok(
    qAngleBetween(fit.rotation, seed) < 1e-6,
    `the seed moved by ${((qAngleBetween(fit.rotation, seed) * 180) / Math.PI).toFixed(3)} degrees`
  );
  assert.ok(distance(applyRigidFit(fit, [0.2, 0, 0]), [1, 2, 3]) < 1e-9);
});

test("a rigid fit ignores pairs at zero weight", () => {
  const good: Vec3[] = [
    [-0.2, 0, 0],
    [0.2, 0, 0],
    [0, 0.3, 0],
  ];
  const withNonsense = fitRigidTransform([
    ...good.map((point) => ({ from: point, to: add(point, [0, 1, 0] as Vec3), weight: 1 })),
    { from: [0, 0, 0] as Vec3, to: [99, -40, 12] as Vec3, weight: 0 },
  ]);
  assert.ok(withNonsense);
  assert.ok(distance(applyRigidFit(withNonsense, good[0]), add(good[0], [0, 1, 0])) < 1e-6);
  assert.equal(fitRigidTransform([{ from: [0, 0, 0], to: [1, 1, 1], weight: 0 }]), null);
});

test("a rigid fit takes the best compromise when nothing fits exactly", () => {
  // Two points pulled apart by the same amount in opposite directions: the
  // fit cannot satisfy either, and the answer has to split the difference
  // rather than pick a side.
  const fit = fitRigidTransform([
    { from: [-0.2, 0, 0], to: [-0.25, 0, 0], weight: 1 },
    { from: [0.2, 0, 0], to: [0.25, 0, 0], weight: 1 },
  ]);
  assert.ok(fit);
  const left = applyRigidFit(fit, [-0.2, 0, 0]);
  const right = applyRigidFit(fit, [0.2, 0, 0]);
  assert.ok(Math.abs(distance(left, right) - 0.4) < 1e-6, "the body stretched");
  assert.ok(Math.abs(left[0] + 0.2) < 1e-6 && Math.abs(right[0] - 0.2) < 1e-6);
});
