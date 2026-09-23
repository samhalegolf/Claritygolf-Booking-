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

import type { ClarityJoint, ConstraintCause, Metres, Unit, Vec3 } from "../../contracts";
import { RIGID_BONES, add, boneKey, distance, dot, scale, sub } from "../../contracts";
import type { MeasuredBodyModel } from "./bodyModel";

export interface ConstraintInput {
  readonly joints: Record<ClarityJoint, Vec3>;
  /** How well each joint is known, 0..1. Drives who yields. */
  readonly trust: Readonly<Record<ClarityJoint, Unit>>;
  readonly model: MeasuredBodyModel;
  /**
   * Joints whose position is doubted more along one direction than across
   * it: the camera's line of sight, and how much worse depth is, as a
   * variance ratio. See contextBids.ts. A joint absent here, or with a ratio
   * of 1, yields the same in every direction.
   */
  readonly depthDoubt?: Readonly<Partial<Record<ClarityJoint, DepthDoubt>>>;
}

export interface DepthDoubt {
  /** Unit vector from the camera toward the joint. */
  readonly ray: Vec3;
  /** Depth variance over picture variance. 1 is no doubt; larger yields more along `ray`. */
  readonly ratio: number;
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
   *
   * This is a FLOOR, not the whole answer: see `toleranceFor`.
   */
  readonly toleranceFraction?: number;
  /**
   * Ceiling on the measured part of a bone's tolerance, as a fraction of its
   * length. Without it a bone measured off bad data would report so much
   * spread that the solver stopped enforcing it at all.
   */
  readonly maxToleranceFraction?: number;
}

const DEFAULTS = {
  iterations: 6,
  minBoneConfidence: 0.35,
  toleranceFraction: 0.02,
  maxToleranceFraction: 0.12,
} as const;

export interface ConstraintResult {
  readonly joints: Record<ClarityJoint, Vec3>;
  /** How far each joint was moved, metres. */
  readonly correctionM: Record<ClarityJoint, Metres>;
  /** Total absolute length error the solver could not remove. */
  readonly residualM: Metres;
  /** Bones that were violated before solving, with their initial error. */
  readonly violations: ReadonlyMap<string, Metres>;
  /**
   * Per moved joint, the neighbour whose bone moved it most, and how much
   * of the joint's movement that bone accounted for.
   */
  readonly causes: Partial<Record<ClarityJoint, ConstraintCause>>;
}

const side = (joint: ClarityJoint): string =>
  joint.startsWith("left") ? "left " : joint.startsWith("right") ? "right " : "";

/** A bone's length rule, in words a coach would use. */
export const boneRule = (a: ClarityJoint, b: ClarityJoint): string => {
  const pair = new Set([a, b].map((joint) => joint.replace(/^(left|right)/, "").toLowerCase()));
  const has = (...names: string[]) => names.every((name) => pair.has(name));
  const s = side(a.startsWith("left") || a.startsWith("right") ? a : b);
  if (has("shoulder") && pair.size === 1) return "shoulder width";
  if (has("hip") && pair.size === 1) return "hip width";
  if (has("shoulder", "elbow")) return `${s}upper arm length`;
  if (has("elbow", "wrist")) return `${s}forearm length`;
  if (has("wrist", "hand")) return `${s}hand length`;
  if (has("hip", "knee")) return `${s}thigh length`;
  if (has("knee", "ankle")) return `${s}shin length`;
  if (has("neck", "shoulder")) return `${s}collarbone length`;
  if (has("sternum", "shoulder")) return `${s}sternum strut`;
  if (has("head", "neck")) return "neck length";
  if (pair.has("heel") || pair.has("toe")) return `${s}foot shape`;
  return `${a} to ${b} length`;
};

export const applyConstraints = (
  input: ConstraintInput,
  options: ConstraintOptions = {}
): ConstraintResult => {
  const iterations = options.iterations ?? DEFAULTS.iterations;
  const minBoneConfidence = options.minBoneConfidence ?? DEFAULTS.minBoneConfidence;
  const tolerance = options.toleranceFraction ?? DEFAULTS.toleranceFraction;
  const maxTolerance = options.maxToleranceFraction ?? DEFAULTS.maxToleranceFraction;

  /*
   * How far out a bone may be before the solver objects.
   *
   * The flat fraction is a noise floor and nothing more. What a bone is
   * really allowed to vary by is what this clip MEASURED it varying by: the
   * body model already records the spread of every length it took, so a
   * femur that held to five millimetres is held to five millimetres, and a
   * shoulder girdle that genuinely changed width as the scapulae retracted
   * and protracted is not ironed flat to satisfy one median.
   *
   * That distinction matters most where a stage above has deliberately left
   * a joint off its nominal place. The girdle allows its corners a measured
   * wander; a solver running on one flat fraction would take it straight
   * back out again, and the allowance would be decoration.
   */
  const toleranceFor = (target: number, spreadM: number): number =>
    Math.max(target * tolerance, Math.min(spreadM, target * maxTolerance));

  const joints = { ...input.joints };
  const original = { ...input.joints };
  const violations = new Map<string, number>();
  /** Per joint, per pushing neighbour: how far that bone moved it, summed over passes. */
  const pushes = new Map<ClarityJoint, Map<ClarityJoint, number>>();
  const push = (joint: ClarityJoint, by: ClarityJoint, step: Vec3) => {
    const byJoint = pushes.get(joint) ?? new Map<ClarityJoint, number>();
    byJoint.set(by, (byJoint.get(by) ?? 0) + Math.sqrt(dot(step, step)));
    pushes.set(joint, byJoint);
  };

  const enforceable = RIGID_BONES.filter((bone) => {
    const measured = input.model.bones[boneKey(bone)];
    return measured && measured.lengthM > 1e-4 && measured.confidence >= minBoneConfidence;
  });

  // Record what was wrong before touching anything, so the report describes
  // the input rather than whatever the solver left behind.
  for (const bone of enforceable) {
    const measured = input.model.bones[boneKey(bone)];
    const actual = distance(joints[bone.from], joints[bone.to]);
    const error = Math.abs(actual - measured.lengthM);
    if (error > toleranceFor(measured.lengthM, measured.spreadM)) {
      violations.set(boneKey(bone), error);
    }
  }

  /** W·direction for one joint: which way, and how readily, it gives. */
  const yieldAlong = (joint: ClarityJoint, direction: Vec3): Vec3 => {
    const inverseTrust = 1 / ((input.trust[joint] ?? 0) + 1e-3);
    const doubt = input.depthDoubt?.[joint];
    if (!doubt || doubt.ratio <= 1) return scale(direction, inverseTrust);
    const along = dot(doubt.ray, direction) * (doubt.ratio - 1);
    return scale(add(direction, scale(doubt.ray, along)), inverseTrust);
  };

  for (let pass = 0; pass < iterations; pass += 1) {
    let moved = false;

    for (const bone of enforceable) {
      const measured = input.model.bones[boneKey(bone)];
      const target = measured.lengthM;
      const from = joints[bone.from];
      const to = joints[bone.to];
      const actual = distance(from, to);

      if (actual < 1e-9) continue;
      const error = actual - target;
      const allowed = toleranceFor(target, measured.spreadM);
      if (Math.abs(error) <= allowed) continue;

      /*
       * Split the correction by inverse trust. A joint nobody has seen takes
       * the whole move; two equally confident joints share it. The epsilons
       * stop two fully trusted joints from deadlocking -- something has to
       * give, and without them neither would.
       *
       * With a line-of-sight doubt, "how easily does this joint move" is no
       * longer one number: it moves easily along the ray and stiffly across
       * it. That is an inverse mass MATRIX rather than a scalar,
       *
       *     W = (I + (ratio - 1) * ray rayᵀ) / trust
       *
       * and the projection is the standard one for it: each end moves along
       * W·direction, scaled so the bone's length error is removed to first
       * order. The joint therefore gives way toward or away from the lens,
       * where the detector was guessing, and holds its place in the picture,
       * where it was not. With no doubt W is the scalar above and the split
       * is exactly the one it always was.
       */
      const excess = error > 0 ? error - allowed : error + allowed;
      const direction = scale(sub(to, from), 1 / actual);
      const fromStep = yieldAlong(bone.from, direction);
      const toStep = yieldAlong(bone.to, direction);
      const total = dot(fromStep, direction) + dot(toStep, direction);

      /*
       * Correct only the excess. A bone sitting at the edge of what it was
       * measured to vary by is not wrong, so pulling it all the way back to
       * the median would be the solver asserting a precision the measurement
       * never had.
       */
      const fromMove = scale(fromStep, excess / total);
      const toMove = scale(toStep, -excess / total);
      joints[bone.from] = add(from, fromMove);
      joints[bone.to] = add(to, toMove);
      push(bone.from, bone.to, fromMove);
      push(bone.to, bone.from, toMove);
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
    const measured = input.model.bones[boneKey(bone)];
    const off = Math.abs(distance(joints[bone.from], joints[bone.to]) - measured.lengthM);
    residualM += Math.max(0, off - toleranceFor(measured.lengthM, measured.spreadM));
  }

  /*
   * The cause is the neighbour that pushed hardest. Path length, not net
   * displacement: two bones pushing a joint opposite ways both did work,
   * and the one that did more of it is the one to point at.
   */
  const causes: Partial<Record<ClarityJoint, ConstraintCause>> = {};
  for (const [joint, byJoint] of pushes) {
    let total = 0;
    let best: ClarityJoint | null = null;
    let bestM = 0;
    for (const [by, movedM] of byJoint) {
      total += movedM;
      if (movedM > bestM) {
        best = by;
        bestM = movedM;
      }
    }
    if (!best || total <= 0) continue;
    causes[joint] = { by: [best], rule: boneRule(joint, best), share: bestM / total, movedM: bestM };
  }

  return { joints, correctionM, residualM, violations, causes };
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
