/**
 * What to do when a lost joint comes back.
 *
 * The plan sets out three cases, and the distinction between them is the
 * whole reason the body model is PERSISTENT rather than rebuilt each frame:
 *
 *   1. It returns close to the predicted structure.
 *      Reattach. Little or no visible correction. Confidence goes up.
 *
 *   2. It returns slightly away.
 *      Reconcile gradually. Do not snap.
 *
 *   3. It returns wildly away.
 *      Treat the reacquisition as uncertain. Require consistent evidence
 *      across subsequent frames AND from connected structures before letting
 *      it substantially move the model.
 *
 * WHY SNAPPING IS THE WRONG DEFAULT
 *
 * A returning detection is not automatically more right than the model it
 * disagrees with. It is one frame of evidence against a structure built from
 * many. Snapping to it makes every flicker of the detector a visible jolt of
 * the body -- and those jolts read as the golfer moving, which is worse than
 * being slightly wrong, because it is wrong in a way that looks like data.
 *
 * CONNECTED STRUCTURES ARE EVIDENCE
 *
 * The plan's example: if returning pelvis observations disagree with the
 * current pelvis, but the thorax, femurs and remaining pelvis observations
 * all support the current reconstruction, the new detections should initially
 * have less influence. And if the returning observations PLUS the connected
 * structures consistently indicate the reconstruction drifted, the model
 * should be allowed to correct.
 *
 * So the verdict is not distance alone. A return that sits far from the
 * prediction but satisfies every connected bone is treated far more
 * generously than one that is closer but makes a femur 20cm long. Distance
 * says how surprising it is; structure says whether it is right.
 */

import type { ClarityJoint, Metres, Unit, Vec3 } from "../../contracts";
import { clampUnit, distance } from "../../contracts";

export type ReacquisitionVerdict = "confirmed" | "reconcile" | "doubted";

export interface ReacquisitionJudgement {
  readonly verdict: ReacquisitionVerdict;
  /**
   * How far toward the observation the model may move THIS frame, 0..1.
   * 1 reattaches outright; small values reconcile over many frames.
   */
  readonly blend: Unit;
  readonly distanceM: Metres;
  /** How well connected bones support the returning position, 0..1. */
  readonly structuralSupport: Unit;
  /** Consecutive frames this candidate has agreed with itself. */
  readonly agreementFrames: number;
}

export interface ReacquisitionOptions {
  readonly heightM?: number;
  /** Within this fraction of height, a return is a confirmation. */
  readonly nearFraction?: number;
  /** Beyond this fraction of height, a return is doubted. */
  readonly farFraction?: number;
  /** Per-frame blend while reconciling a moderate disagreement. */
  readonly reconcileRate?: number;
  /** Per-frame blend while a doubted candidate is still on probation. */
  readonly doubtedRate?: number;
  /** Frames of self-consistent evidence that promote a doubted candidate. */
  readonly agreementFramesRequired?: number;
  /** How far a candidate may drift and still count as the same candidate. */
  readonly agreementToleranceFraction?: number;
}

const DEFAULTS = {
  heightM: 1.8,
  nearFraction: 0.02,
  farFraction: 0.09,
  reconcileRate: 0.28,
  doubtedRate: 0.04,
  agreementFramesRequired: 4,
  agreementToleranceFraction: 0.035,
} as const;

interface Candidate {
  position: Vec3;
  frames: number;
}

/**
 * Carries the probation state for doubted returns.
 *
 * Stateful because the plan's third case is explicitly about evidence ACROSS
 * FRAMES: a wild return earns influence by being repeated, not by being
 * large. A pure function could not remember that it had seen this candidate
 * before, which is the only thing that distinguishes a genuine relocation
 * from a detector that is flickering.
 */
export class ReacquisitionTracker {
  private readonly candidates = new Map<ClarityJoint, Candidate>();
  private readonly options: Required<ReacquisitionOptions>;

  constructor(options: ReacquisitionOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Called when a joint is not observed, so a stale candidate does not persist. */
  forget(joint: ClarityJoint) {
    this.candidates.delete(joint);
  }

  judge(
    joint: ClarityJoint,
    observed: Vec3,
    predicted: Vec3,
    structuralSupport: Unit,
    /**
     * Extra metres of slack, for how far the joint could plausibly have moved
     * while unseen. A prediction that is ten frames stale is not evidence of
     * anything much, and judging a return against it as if it were fresh
     * would reject every recovery from a long gap.
     */
    extraToleranceM = 0
  ): ReacquisitionJudgement {
    const { heightM } = this.options;
    const near = this.options.nearFraction * heightM;
    const far = this.options.farFraction * heightM;
    const agreementTolerance = this.options.agreementToleranceFraction * heightM;

    const distanceM = distance(observed, predicted);
    const support = clampUnit(structuralSupport);

    // Track whether this is the same place the joint claimed to be last frame.
    const previous = this.candidates.get(joint);
    const agreementFrames =
      previous && distance(previous.position, observed) <= agreementTolerance
        ? previous.frames + 1
        : 1;
    this.candidates.set(joint, { position: observed, frames: agreementFrames });

    /*
     * Strong structural support widens what counts as "close".
     *
     * This is the plan's rule that connected structures are evidence. A
     * return that satisfies every connected bone is not really a surprise,
     * however far it sits from a prediction that may itself have drifted --
     * so the thresholds move out to meet it. Support near zero tightens them
     * instead, because the body is actively contradicting the detection.
     */
    const supportScale = 0.6 + support * 1.4;
    const nearThreshold = near * supportScale + extraToleranceM;
    const farThreshold = far * supportScale + extraToleranceM;

    if (distanceM <= nearThreshold) {
      return {
        verdict: "confirmed",
        blend: 1,
        distanceM,
        structuralSupport: support,
        agreementFrames,
      };
    }

    if (distanceM <= farThreshold) {
      return {
        verdict: "reconcile",
        // Better-supported returns reconcile faster, but never instantly:
        // gradual is the rule, and this only sets how gradual.
        blend: clampUnit(this.options.reconcileRate * (0.5 + support * 0.5)),
        distanceM,
        structuralSupport: support,
        agreementFrames,
      };
    }

    /*
     * Wildly away. It gets almost no influence -- until it has said the same
     * thing several frames running. Repetition is what separates a genuine
     * relocation from a detector flickering onto the background, and it is
     * the only evidence available that does not require trusting the
     * detection we already doubt.
     */
    const proven = agreementFrames >= this.options.agreementFramesRequired;
    return {
      verdict: proven ? "reconcile" : "doubted",
      blend: proven
        ? clampUnit(this.options.reconcileRate * (0.4 + support * 0.6))
        : clampUnit(this.options.doubtedRate * (0.5 + support * 0.5)),
      distanceM,
      structuralSupport: support,
      agreementFrames,
    };
  }
}

/**
 * Turn metres of disagreement with connected bones into a 0..1 support score.
 *
 * Scaled by how many neighbours actually voted: one satisfied bone is weak
 * evidence, three is strong. With no confident neighbour at all the result is
 * 0.5 -- not support, and not opposition, because the body has said nothing.
 */
export const supportFromDisagreement = (
  disagreementM: Metres,
  neighboursUsed: number,
  // Annotated rather than inferred: `DEFAULTS` is `as const`, so an inferred
  // parameter type would be the literal 1.8 and reject every real height.
  heightM: number = DEFAULTS.heightM
): Unit => {
  if (neighboursUsed === 0) return 0.5;
  const perBone = disagreementM / neighboursUsed;
  // 2% of height per bone is roughly detection noise; 10% is a broken limb.
  return clampUnit(1 - (perBone - heightM * 0.02) / (heightM * 0.08));
};
