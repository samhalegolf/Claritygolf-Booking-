/**
 * Physical constraints: connected joints stay connected, bones keep length.
 *
 * WHAT KIND OF ASSUMPTION THIS IS
 *
 * The plan draws a hard line between assumptions from physical connectivity
 * and assumptions from golf technique. Everything here is the first kind:
 *
 *   a femur does not change length      yes, enforced
 *   a forearm does not stretch          yes, enforced
 *   connected joints stay connected     yes, enforced
 *   the pelvis stays coherent           yes, enforced
 *
 *   the hands follow a particular path  NO -- that is technique
 *   the swing is on a plane             NO -- that is technique
 *   the sequence goes hips-then-torso   NO -- that is technique
 *
 * If the golfer does something anatomically possible and strange, everything
 * here leaves it alone. The solver only ever objects to the impossible.
 *
 * HOW IT SOLVES
 *
 * Gauss-Seidel projection, the position-based-dynamics approach: walk the
 * bones, push each one back to its measured length, repeat. It converges
 * quickly for a skeleton and, unlike a global solve, makes it obvious which
 * constraint moved what.
 *
 * EVIDENCE DECIDES WHO MOVES
 *
 * A violated bone is corrected by moving both ends -- but in inverse
 * proportion to how well each end is known. A confidently observed shoulder
 * and a reconstructed elbow disagree; the elbow moves. This is the difference
 * between a solver that repairs a reconstruction and one that quietly
 * degrades good observations to satisfy a bone length measured from bad ones.
 */

import type { ClarityJoint, Metres, Unit, Vec3 } from "../../contracts";
import { RIGID_BONES, add, boneKey, distance, scale, sub } from "../../contracts";
import type { MeasuredBodyModel } from "./bodyModel";

export interface ConstraintInput {
  readonly joints: Record<ClarityJoint, Vec3>;
  /** How well each joint is known, 0..1. Drives who yields. */
  readonly trust: Readonly<Record<ClarityJoint, Unit>>;
  readonly model: MeasuredBodyModel;
}

export interface ConstraintOptions {
  readonly iterations?: number;
  /**
   * Bone-model confidence below which a bone is not enforced at all.
   *
   * A length measured from a handful of frames, or one that varied wildly, is
   * not a fact about the body -- it is a summary of bad data. Enforcing it
   * would push good joints to satisfy a number that was never right.
   */
  readonly minBoneConfidence?: number;
  /**
   * Fractional length error below which a bone is left alone. Detection noise
   * puts every bone permanently a millimetre or two out, and chasing that
   * would have the solver fidgeting with every joint on every frame.
   */
  readonly toleranceFraction?: number;
}

const DEFAULTS = {
  iterations: 6,
  minBoneConfidence: 0.35,
  toleranceFraction: 0.02,
} as const;

export interface ConstraintResult {
  readonly joints: Record<ClarityJoint, Vec3>;
  /** How far each joint was moved, metres. */
  readonly correctionM: Record<ClarityJoint, Metres>;
  /** Total absolute length error the solver could not remove. */
  readonly residualM: Metres;
  /** Bones that were violated before solving, with their initial error. */
  readonly violations: ReadonlyMap<string, Metres>;
}

export const applyConstraints = (
  input: ConstraintInput,
  options: ConstraintOptions = {}
): ConstraintResult => {
  const iterations = options.iterations ?? DEFAULTS.iterations;
  const minBoneConfidence = options.minBoneConfidence ?? DEFAULTS.minBoneConfidence;
  const tolerance = options.toleranceFraction ?? DEFAULTS.toleranceFraction;

  const joints = { ...input.joints };
  const original = { ...input.joints };
  const violations = new Map<string, number>();

  const enforceable = RIGID_BONES.filter((bone) => {
    const measured = input.model.bones[boneKey(bone)];
    return measured && measured.lengthM > 1e-4 && measured.confidence >= minBoneConfidence;
  });

  // Record what was wrong before touching anything, so the report describes
  // the input rather than whatever the solver left behind.
  for (const bone of enforceable) {
    const target = input.model.bones[boneKey(bone)].lengthM;
    const actual = distance(joints[bone.from], joints[bone.to]);
    const error = Math.abs(actual - target);
    if (error > target * tolerance) violations.set(boneKey(bone), error);
  }

  for (let pass = 0; pass < iterations; pass += 1) {
    let moved = false;

    for (const bone of enforceable) {
      const target = input.model.bones[boneKey(bone)].lengthM;
      const from = joints[bone.from];
      const to = joints[bone.to];
      const actual = distance(from, to);

      if (actual < 1e-9) continue;
      const error = actual - target;
      if (Math.abs(error) <= target * tolerance) continue;

      /*
       * Split the correction by inverse trust. A joint nobody has seen takes
       * the whole move; two equally confident joints share it. The epsilons
       * stop two fully trusted joints from deadlocking -- something has to
       * give, and without them neither would.
       */
      const fromTrust = (input.trust[bone.from] ?? 0) + 1e-3;
      const toTrust = (input.trust[bone.to] ?? 0) + 1e-3;
      const total = fromTrust + toTrust;
      const fromShare = toTrust / total;
      const toShare = fromTrust / total;

      const direction = scale(sub(to, from), 1 / actual);
      joints[bone.from] = add(from, scale(direction, error * fromShare));
      joints[bone.to] = sub(to, scale(direction, error * toShare));
      moved = true;
    }

    // Converged. Further passes would only re-walk a satisfied skeleton.
    if (!moved) break;
  }

  const correctionM = {} as Record<ClarityJoint, number>;
  for (const joint of Object.keys(joints) as ClarityJoint[]) {
    correctionM[joint] = distance(joints[joint], original[joint]);
  }

  let residualM = 0;
  for (const bone of enforceable) {
    const target = input.model.bones[boneKey(bone)].lengthM;
    residualM += Math.abs(distance(joints[bone.from], joints[bone.to]) - target);
  }

  return { joints, correctionM, residualM, violations };
};

/**
 * How badly a candidate position for one joint disagrees with the bones
 * connecting it to joints we are currently confident about.
 *
 * This is the reacquisition test. When a joint reappears somewhere
 * unexpected, the question is not "is it near where we predicted?" -- the
 * prediction may have drifted -- but "does the rest of the body support it?".
 * A returning hip that puts the femur at exactly its measured length, against
 * a knee nobody doubts, is evidence the prediction was wrong. One that makes
 * the femur 20cm long is evidence the detection is.
 *
 * Returns metres of total disagreement. Lower is better; zero means every
 * connected bone would be satisfied exactly.
 */
export const structuralDisagreement = (
  joint: ClarityJoint,
  candidate: Vec3,
  joints: Readonly<Record<ClarityJoint, Vec3>>,
  trust: Readonly<Record<ClarityJoint, Unit>>,
  model: MeasuredBodyModel,
  minNeighbourTrust = 0.5
): { disagreementM: Metres; neighboursUsed: number } => {
  let disagreementM = 0;
  let neighboursUsed = 0;

  for (const bone of RIGID_BONES) {
    const other =
      bone.from === joint ? bone.to : bone.to === joint ? bone.from : null;
    if (!other) continue;

    const measured = model.bones[boneKey(bone)];
    if (!measured || measured.lengthM < 1e-4 || measured.confidence < 0.35) continue;
    // Only joints we actually believe can serve as evidence about another.
    if ((trust[other] ?? 0) < minNeighbourTrust) continue;

    disagreementM += Math.abs(distance(candidate, joints[other]) - measured.lengthM);
    neighboursUsed += 1;
  }

  return { disagreementM, neighboursUsed };
};
