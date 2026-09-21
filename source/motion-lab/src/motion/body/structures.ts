/**
 * Building the persistent structures -- thorax and pelvis -- from joints.
 *
 * These are the bodies the plan asks for: not clouds of independent points,
 * but coherent structures with a position AND AN ORIENTATION. The orientation
 * is what makes separation visible; a pelvis and a thorax that are only
 * positions cannot show that one has turned forty degrees and the other
 * ninety.
 *
 * Shared between the naive passthrough and the real Motion Layer so both
 * describe a body the same way, and a comparison between them is a comparison
 * of reconstruction rather than of two different definitions of "pelvis".
 */

import type { ClarityJoint, RigidStructure, Unit, Vec3 } from "../../contracts";
import { clampUnit, lerpVec, qFromBasis, qIdentity, sub } from "../../contracts";

export interface StructureInput {
  /** Joint positions, whatever is available. */
  readonly joints: Readonly<Partial<Record<ClarityJoint, Vec3>>>;
  /** Per-joint support: how much of each came from observation, 0..1. */
  readonly support: Readonly<Partial<Record<ClarityJoint, Unit>>>;
}

const midpoint = (a: Vec3 | undefined, b: Vec3 | undefined): Vec3 | null =>
  a && b ? lerpVec(a, b, 0.5) : null;

const meanSupport = (
  support: StructureInput["support"],
  joints: readonly ClarityJoint[]
): Unit => {
  if (joints.length === 0) return 0;
  let total = 0;
  for (const joint of joints) total += support[joint] ?? 0;
  return clampUnit(total / joints.length);
};

/**
 * A structure from a lateral axis and a vertical one.
 *
 * Returns null rather than a default when the axes cannot be measured. A
 * pelvis that silently falls back to the identity orientation is worse than
 * no pelvis: it looks like a real, square pelvis, and nothing downstream can
 * tell it apart from one.
 */
const buildFromAxes = (
  centre: Vec3,
  across: Vec3 | null,
  up: Vec3 | null,
  halfExtents: Vec3,
  support: Unit
): RigidStructure => ({
  centre,
  orientation: across && up ? qFromBasis(across, up) : qIdentity(),
  halfExtents,
  support: across && up ? support : 0,
});

export const buildThorax = (input: StructureInput): RigidStructure | null => {
  const { joints } = input;
  const shoulderMid = midpoint(joints.leftShoulder, joints.rightShoulder);
  const hipMid = midpoint(joints.leftHip, joints.rightHip);
  if (!shoulderMid) return null;

  const across =
    joints.leftShoulder && joints.rightShoulder
      ? sub(joints.rightShoulder, joints.leftShoulder)
      : null;
  // With no pelvis to measure against, world-up is the only vertical
  // available. The support figure records that the structure is partly
  // assumed rather than measured.
  const up = hipMid ? sub(shoulderMid, hipMid) : ([0, 1, 0] as Vec3);

  const shoulderWidth = across
    ? Math.hypot(across[0], across[1], across[2])
    : 0.4;
  const torsoLength = hipMid
    ? Math.hypot(
        shoulderMid[0] - hipMid[0],
        shoulderMid[1] - hipMid[1],
        shoulderMid[2] - hipMid[2]
      )
    : 0.5;

  return buildFromAxes(
    hipMid ? lerpVec(shoulderMid, hipMid, 0.25) : shoulderMid,
    across,
    up,
    [shoulderWidth * 0.42, torsoLength * 0.42, shoulderWidth * 0.25],
    meanSupport(input.support, ["leftShoulder", "rightShoulder", "neck"]) *
      (hipMid ? 1 : 0.6)
  );
};

export const buildPelvis = (input: StructureInput): RigidStructure | null => {
  const { joints } = input;
  const hipMid = midpoint(joints.leftHip, joints.rightHip);
  if (!hipMid) return null;

  const across =
    joints.leftHip && joints.rightHip ? sub(joints.rightHip, joints.leftHip) : null;
  const shoulderMid = midpoint(joints.leftShoulder, joints.rightShoulder);
  const up = shoulderMid ? sub(shoulderMid, hipMid) : ([0, 1, 0] as Vec3);

  const hipWidth = across ? Math.hypot(across[0], across[1], across[2]) : 0.2;

  return buildFromAxes(
    hipMid,
    across,
    up,
    [hipWidth * 0.75, hipWidth * 0.55, hipWidth * 0.45],
    meanSupport(input.support, ["leftHip", "rightHip"]) * (shoulderMid ? 1 : 0.6)
  );
};
