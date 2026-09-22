/**
 * Observations the body contradicts, rejected on EVERY frame.
 *
 * THE HOLE THIS FILLS
 *
 * Every other guard in the Motion Layer is shaped around a joint that goes
 * away or spikes. `rejectUnsupportedReturns` judges a joint that was MISSING
 * and has come back -- its own comment says "a joint that was seen last frame
 * is simply tracked". `findJumps` judges the second difference, which only
 * has anything to say about a CHANGE in the error.
 *
 * Neither of them can see the failure that prompted this file: a landmark
 * that slides off the joint it belongs to, settles somewhere else on the
 * body, and stays there for a dozen frames at full detector confidence. A
 * left shoulder walking onto the middle of the back is the case in hand.
 * Written out as a track it looks like this:
 *
 *     good good good | bad bad bad bad bad bad | good good
 *
 * The joint never goes missing, so nothing validates it as a return. And the
 * second difference is zero everywhere inside the plateau, because a constant
 * error does not change -- only the two frames at the seam deviate,
 * `suppressNeighbours` keeps the peak of those, and `repairJump` replaces
 * that ONE frame with the midpoint of its neighbours, which is halfway
 * between the right answer and the wrong one. Every remaining frame of the
 * plateau sails through untouched and fully trusted. If the slide takes three
 * or four frames rather than one, even the seam is smooth and nothing is
 * flagged at all.
 *
 * The detector cannot help here. `visibility` says the body part is in the
 * picture, not that the point landed in the right place on it, so a landmark
 * on the spine reports the same 1.0 as a correct one.
 *
 * WHAT CAN TELL
 *
 * The bones. A shoulder 150mm from where it belongs makes the collarbone and
 * the humerus wrong by as much of that 150mm as lies ALONG them, and a body
 * cannot change its own bone lengths.
 *
 * That last clause is the whole difficulty, and it is why this asks per bone
 * rather than in aggregate. A bone only feels the component of an error that
 * changes its length: the same displacement that shortens a collarbone by
 * 190mm can leave a humerus almost exactly its measured length, if it
 * happened to run the other way. Summing the disagreement over a joint's
 * bones and dividing -- which is what `structuralDisagreement` does, rightly,
 * for the question IT answers -- averages the bones that felt the error
 * together with the ones that did not, and a real 185mm slip comes out as
 * 39mm of "mean disagreement", under any threshold loose enough to be safe.
 *
 * WHICH END OF A BROKEN BONE IS THE WRONG ONE
 *
 * A violated bone says one of its two ends is wrong, not which. Rejecting
 * both would delete a good joint for the crime of being attached to a bad
 * one, and the plan is firm that a reconstruction which improves bad data by
 * degrading good data has improved nothing.
 *
 * The rule is therefore: a joint is rejected only when EVERY enforceable bone
 * attached to it is broken. If even one is satisfied, the joint is still in
 * the right place relative to something, and the break is better explained by
 * the joint at the other end. On the case in hand the separation is total
 * rather than a matter of degree -- with the left shoulder sitting on the
 * spine, every bone it has is wrong, and every one of its neighbours has an
 * intact bone pointing away from the damage:
 *
 *   leftShoulder   neck BROKEN   rightShoulder BROKEN   leftElbow BROKEN
 *   rightShoulder  neck BROKEN   leftShoulder  BROKEN   rightElbow ok
 *   leftElbow      leftShoulder BROKEN   leftWrist ok
 *   neck           both shoulders BROKEN   head ok
 *
 * So the shoulder is the only candidate, and the three joints that merely
 * touch it keep their observations. Frames are resolved worst-first and
 * re-judged after each rejection, because removing a joint also withdraws it
 * as evidence about its neighbours.
 *
 * WHAT THIS DELIBERATELY CANNOT CATCH
 *
 * A joint displaced ALONG one of its own bones, which keeps that bone's
 * length exactly right. That is not a threshold that could be tightened --
 * the body genuinely has no evidence distinguishing it from the joint at the
 * far end being wrong, and inventing a preference between the two would be
 * guessing dressed as physics. The bones say what they can say.
 *
 * TWO WITNESSES, OR NO VERDICT
 *
 * A joint with a single enforceable bone is never rejected here. With one
 * bone there is no way to tell which end broke it, and guessing is a coin
 * flip against real data. That exempts the hands, which hang off the wrists
 * alone, and the head, which hangs off the neck. Both are already covered:
 * the hands by the grip bubble in `armDerivation`, the head by the smoother.
 *
 * HOW BROKEN IS BROKEN
 *
 * Per bone, against that bone's OWN measured spread rather than one number
 * for the whole body -- the same reasoning `jumps.ts` gives for measuring its
 * scale locally instead of over the whole track. `MeasuredBone.spreadM` is
 * the median absolute deviation of that bone's length across the clip, which
 * is precisely how much this detector wobbles on this segment of this
 * golfer. A forearm the detector never had a fix on sets itself a loose
 * threshold and is judged gently; a femur it nailed sets itself a tight one.
 *
 * The floor matters as much as the multiple. On a synthetic fixture the
 * spread is exactly zero, and without a floor every bone would be infinitely
 * strict and the stage would reject the whole body.
 *
 * WHY THIS RUNS BEFORE REACQUISITION VALIDATION
 *
 * Rejecting a plateau turns it into a gap, and the observations on the far
 * side of that gap are then RETURNS -- which is precisely the case
 * `rejectUnsupportedReturns` was built to judge. Run the other way round,
 * reacquisition sees an unbroken track and has nothing to say about it.
 */

import type { ClarityJoint, Metres, Unit, Vec3 } from "../../contracts";
import { CLARITY_JOINTS, RIGID_BONES, boneKey, distance } from "../../contracts";
import type { MeasuredBodyModel } from "./bodyModel";
import type { Tracks } from "./tracks";

export interface ContradictionOptions {
  /**
   * Multiples of a bone's own measured spread at which its length is no
   * longer detection noise. Four is loose enough that a well-tracked segment
   * is not held to an unreasonably tight standard on the frames it happens to
   * wobble, and tight enough that a limb genuinely out of place clears it.
   */
  readonly sigmas?: number;
  /**
   * A floor under every bone's tolerance, as a fraction of standing height.
   * About 36mm on a 1.8m golfer. Without it a bone measured with zero spread
   * would be held to zero tolerance, and a body whose detector happened to be
   * consistent would be rejected wholesale.
   */
  readonly floorFractionOfHeight?: number;
  /**
   * Enforceable bones a joint needs before it can be judged at all. Two, for
   * the reason in the header: one bone cannot say which end broke it.
   */
  readonly minBones?: number;
  /** Bone-model confidence below which a measured length is not evidence. */
  readonly minBoneConfidence?: number;
  /** Trust a neighbour needs before its position counts as evidence. */
  readonly minNeighbourTrust?: number;
  readonly heightM?: number;
}

const DEFAULTS = {
  sigmas: 4,
  floorFractionOfHeight: 0.02,
  minBones: 2,
  minBoneConfidence: 0.35,
  minNeighbourTrust: 0.5,
  heightM: 1.8,
} as const;

export interface ContradictionReport {
  /** How many observations were rejected, per joint. Joints with none are absent. */
  readonly rejected: Readonly<Partial<Record<ClarityJoint, number>>>;
  readonly total: number;
  /** The largest single excess rejected, metres beyond tolerance. For the debug readout. */
  readonly worstM: Metres;
}

interface Verdict {
  /** Metres beyond tolerance, totalled over the joint's bones. Zero if not a candidate. */
  readonly excessM: number;
  readonly contradicted: boolean;
}

/**
 * How the bones attached to one joint judge where it claims to be.
 *
 * Not `structuralDisagreement`: that answers "how far is this from satisfying
 * the body", which is the right question for reacquisition, where the
 * candidate is being scored against alternatives. Here the question is "is
 * there any bone this joint still satisfies", and an average would hide
 * exactly the bone that answers it.
 */
const judge = (
  joint: ClarityJoint,
  joints: Readonly<Record<ClarityJoint, Vec3>>,
  trust: Readonly<Record<ClarityJoint, Unit>>,
  model: MeasuredBodyModel,
  options: Required<Omit<ContradictionOptions, "heightM">> & { floorM: number }
): Verdict => {
  let bones = 0;
  let broken = 0;
  let excessM = 0;

  for (const bone of RIGID_BONES) {
    const other = bone.from === joint ? bone.to : bone.to === joint ? bone.from : null;
    if (!other) continue;

    const measured = model.bones[boneKey(bone)];
    if (!measured || measured.lengthM < 1e-4) continue;
    if (measured.confidence < options.minBoneConfidence) continue;
    // A joint nobody located this frame cannot testify about another.
    if ((trust[other] ?? 0) < options.minNeighbourTrust) continue;

    bones += 1;
    const tolerance = Math.max(options.floorM, measured.spreadM * options.sigmas);
    const error = Math.abs(distance(joints[joint], joints[other]) - measured.lengthM);
    if (error > tolerance) {
      broken += 1;
      excessM += error - tolerance;
    }
  }

  // Every bone it has, or it keeps its observation.
  const contradicted = bones >= options.minBones && broken === bones;
  return { excessM: contradicted ? excessM : 0, contradicted };
};

/**
 * Reject, in place, the observations the rest of the body contradicts.
 *
 * Mutates `tracks`: a rejected sample becomes null, which is the same shape
 * `rejectUnsupportedReturns` leaves behind and what the gap logic downstream
 * reads. It does not fill anything in -- saying "this was not observed" is the
 * whole claim, and bridging it is a later stage's job, with its own provenance
 * and its own cost in confidence.
 */
export const rejectContradictedObservations = (
  tracks: Tracks,
  model: MeasuredBodyModel,
  frameCount: number,
  options: ContradictionOptions = {}
): ContradictionReport => {
  const heightM = options.heightM ?? DEFAULTS.heightM;
  const settings = {
    sigmas: options.sigmas ?? DEFAULTS.sigmas,
    floorFractionOfHeight: options.floorFractionOfHeight ?? DEFAULTS.floorFractionOfHeight,
    minBones: options.minBones ?? DEFAULTS.minBones,
    minBoneConfidence: options.minBoneConfidence ?? DEFAULTS.minBoneConfidence,
    minNeighbourTrust: options.minNeighbourTrust ?? DEFAULTS.minNeighbourTrust,
    floorM: (options.floorFractionOfHeight ?? DEFAULTS.floorFractionOfHeight) * heightM,
  };

  const rejected: Partial<Record<ClarityJoint, number>> = {};
  let total = 0;
  let worstM = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const joints = {} as Record<ClarityJoint, Vec3>;
    const trust = {} as Record<ClarityJoint, Unit>;
    for (const joint of CLARITY_JOINTS) {
      const sample = tracks[joint].samples[index];
      joints[joint] = sample?.position ?? [0, 0, 0];
      trust[joint] = sample ? sample.visibility : 0;
    }

    /*
     * Worst-first, until nothing is left contradicted.
     *
     * The loop terminates on its own: every pass either stops or removes one
     * joint, and a removal also withdraws that joint as evidence about its
     * neighbours -- so the joints it was breaking stop being contradicted,
     * and anything left with fewer than two witnesses drops out of
     * contention. A cascade runs out of accusers rather than running away.
     * The bound is belt and braces.
     */
    for (let pass = 0; pass < CLARITY_JOINTS.length; pass += 1) {
      let culprit: ClarityJoint | null = null;
      let culpritM = 0;

      for (const joint of CLARITY_JOINTS) {
        if (!tracks[joint].samples[index]) continue;
        const verdict = judge(joint, joints, trust, model, settings);
        if (verdict.contradicted && verdict.excessM > culpritM) {
          culpritM = verdict.excessM;
          culprit = joint;
        }
      }

      if (!culprit) break;

      tracks[culprit].samples[index] = null;
      trust[culprit] = 0;
      rejected[culprit] = (rejected[culprit] ?? 0) + 1;
      total += 1;
      worstM = Math.max(worstM, culpritM);
    }
  }

  return { rejected, total, worstM };
};
