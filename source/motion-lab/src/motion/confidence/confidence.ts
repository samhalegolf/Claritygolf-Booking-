/**
 * Reconstruction confidence.
 *
 * WHAT THIS MEASURES: how much reconstruction and assumption was required to
 * produce this frame.
 *
 * WHAT IT DOES NOT MEASURE: whether the golf movement looks normal. A weird
 * but cleanly observed swing must score HIGH. If a change here would lower
 * the score for an unusual movement that the detector saw perfectly well,
 * that change is wrong.
 *
 * No value is defined as good or bad. The first version exists so real swings
 * can establish what useful ranges look like; a threshold written now would
 * be a guess wearing a number's clothing.
 */

import type {
  ClarityStructure,
  ConfidenceComponents,
  FrameConfidence,
  Unit,
} from "../../contracts";
import { CLARITY_STRUCTURES, clampUnit } from "../../contracts";

/**
 * How the components roll into `overall`.
 *
 * `clubPoint` is deliberately ABSENT. The plan is explicit that a poor club
 * track must not automatically invalidate an otherwise strong body
 * reconstruction, so the overall score is a BODY score. Club confidence is
 * still reported -- in `components.clubPoint` and in `structures.club` -- it
 * simply does not drag the body number down with it.
 */
export const COMPONENT_WEIGHTS: Readonly<Record<keyof ConfidenceComponents, number>> = {
  directObservation: 0.3,
  trackingContinuity: 0.2,
  jumpCorrection: 0.15,
  gapReconstruction: 0.2,
  bodyConstraintCorrection: 0.15,
  clubPoint: 0,
};

export const PERFECT_COMPONENTS: ConfidenceComponents = {
  directObservation: 1,
  trackingContinuity: 1,
  jumpCorrection: 1,
  gapReconstruction: 1,
  bodyConstraintCorrection: 1,
  clubPoint: 1,
};

/** Weighted mean of the body components. Weights are normalised, not assumed to sum to 1. */
export const rollUpOverall = (components: ConfidenceComponents): Unit => {
  let weighted = 0;
  let totalWeight = 0;
  for (const key of Object.keys(COMPONENT_WEIGHTS) as (keyof ConfidenceComponents)[]) {
    const weight = COMPONENT_WEIGHTS[key];
    if (weight <= 0) continue;
    weighted += clampUnit(components[key]) * weight;
    totalWeight += weight;
  }
  return totalWeight <= 0 ? 0 : clampUnit(weighted / totalWeight);
};

export const emptyStructureConfidence = (value: Unit): Record<ClarityStructure, Unit> =>
  Object.fromEntries(
    CLARITY_STRUCTURES.map((structure) => [structure, clampUnit(value)])
  ) as Record<ClarityStructure, Unit>;

export const buildFrameConfidence = (
  components: ConfidenceComponents,
  structures: Readonly<Record<ClarityStructure, Unit>>
): FrameConfidence => ({
  overall: rollUpOverall(components),
  components: {
    directObservation: clampUnit(components.directObservation),
    trackingContinuity: clampUnit(components.trackingContinuity),
    jumpCorrection: clampUnit(components.jumpCorrection),
    gapReconstruction: clampUnit(components.gapReconstruction),
    bodyConstraintCorrection: clampUnit(components.bodyConstraintCorrection),
    clubPoint: clampUnit(components.clubPoint),
  },
  structures,
});

/**
 * How a raw measurement of "how bad was it" becomes a 0..1 component.
 *
 * `scale` is the amount of the thing at which the component reaches roughly
 * 0.37. The curve is exponential rather than linear so that a little
 * correction barely dents the score while a lot of it falls away fast --
 * which matches how the quantity actually behaves. Ten millimetres of
 * constraint correction is nothing; a hundred is a different reconstruction.
 */
export const penalise = (amount: number, scale: number): Unit => {
  if (!Number.isFinite(amount) || amount <= 0) return 1;
  if (scale <= 0) return 0;
  return clampUnit(Math.exp(-amount / scale));
};

/** Scales used across the layer, gathered so they can be tuned in one place. */
export const PENALTY_SCALES = {
  /** Metres of constraint correction per frame. */
  constraintCorrectionM: 0.08,
  /** Metres of damped single-frame jump. */
  jumpM: 0.12,
  /** Frames of gap being bridged. */
  gapFrames: 9,
  /** Frames since the club head was last directly observed. */
  clubStalenessFrames: 6,
} as const;
