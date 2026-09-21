/**
 * How a fixed pot of virtual mass is distributed over the body.
 *
 * The plan's constraints, restated so they are hard to drift from:
 *
 *   - A FIXED RELATIVE POT. 100 virtual units. Absolute body weight is never
 *     required, never estimated, and never displayed as kilograms.
 *   - Distribution follows published segment fractions applied to the
 *     PERSONALISED geometry measured for this golfer, not to a generic body.
 *   - Nothing here infers body fat or muscle composition, and no readout
 *     downstream may imply that it does.
 *
 * The fractions are the standard Dempster/Winter cadaver-derived segment
 * masses as proportions of total body mass. They are a population average,
 * which is exactly the right amount of assumption for a relative signal: the
 * interesting quantity is how the centre MOVES during a swing, and that is
 * driven overwhelmingly by measured geometry rather than by whether this
 * golfer's forearm is 1.6% or 1.7% of them.
 */

import type { ClarityJoint } from "../../contracts";

/** The whole pot. Everything below sums to this. */
export const TOTAL_MASS_UNITS = 100;

/**
 * A lump of mass riding on the body.
 *
 * Mass is modelled as a weighted cloud attached to the skeleton rather than
 * one point per bone, as the plan asks. Each parcel sits at a fraction along
 * the line between two joints -- `at: 0` is `from`, `at: 1` is `to` -- so the
 * cloud deforms with the measured body instead of being a rigid add-on.
 */
export interface MassParcel {
  readonly label: string;
  readonly from: ClarityJoint;
  readonly to: ClarityJoint;
  /** Position along from->to, 0..1, of this parcel's centre. */
  readonly at: number;
  /** Share of TOTAL_MASS_UNITS carried here. */
  readonly units: number;
  /**
   * True when this parcel sits above the hip joints and therefore belongs to
   * the Upper Mass Map. The trunk is split into parcels precisely so this
   * line can be drawn at the hips rather than fudged.
   */
  readonly upper: boolean;
}

/**
 * Centre-of-mass positions along each segment are also from Winter: they are
 * measured from the proximal joint, which is why e.g. the thigh sits at 0.433
 * rather than at the midpoint.
 */
export const MASS_PARCELS: readonly MassParcel[] = [
  // Head and neck: 8.1% of body mass, riding near the cranium.
  { label: "head", from: "neck", to: "head", at: 0.7, units: 8.1, upper: true },

  // Trunk, 49.7% total, split into three parcels so the upper/lower line can
  // fall at the hip joints. Shoulder-to-hip is the axis; the shares are
  // thorax 21.6, lumbar 16.2, pelvis 11.9.
  { label: "thorax-left", from: "leftShoulder", to: "leftHip", at: 0.2, units: 10.8, upper: true },
  { label: "thorax-right", from: "rightShoulder", to: "rightHip", at: 0.2, units: 10.8, upper: true },
  { label: "lumbar-left", from: "leftShoulder", to: "leftHip", at: 0.62, units: 8.1, upper: true },
  { label: "lumbar-right", from: "rightShoulder", to: "rightHip", at: 0.62, units: 8.1, upper: true },
  // The pelvis parcels sit AT the hip joints and are the boundary case. They
  // are counted as lower: the Upper Mass Map is "from the hip joints upward",
  // so mass centred on the hip line is not above it.
  { label: "pelvis-left", from: "leftHip", to: "rightHip", at: 0.25, units: 5.95, upper: false },
  { label: "pelvis-right", from: "leftHip", to: "rightHip", at: 0.75, units: 5.95, upper: false },

  // Arms. Upper arm 2.8%, forearm 1.6%, hand 0.6% -- each side.
  { label: "upperarm-left", from: "leftShoulder", to: "leftElbow", at: 0.436, units: 2.8, upper: true },
  { label: "forearm-left", from: "leftElbow", to: "leftWrist", at: 0.43, units: 1.6, upper: true },
  { label: "hand-left", from: "leftWrist", to: "leftHand", at: 0.506, units: 0.6, upper: true },
  { label: "upperarm-right", from: "rightShoulder", to: "rightElbow", at: 0.436, units: 2.8, upper: true },
  { label: "forearm-right", from: "rightElbow", to: "rightWrist", at: 0.43, units: 1.6, upper: true },
  { label: "hand-right", from: "rightWrist", to: "rightHand", at: 0.506, units: 0.6, upper: true },

  // Legs. Thigh 10.0%, shank 4.65%, foot 1.45% -- each side.
  { label: "thigh-left", from: "leftHip", to: "leftKnee", at: 0.433, units: 10.0, upper: false },
  { label: "shank-left", from: "leftKnee", to: "leftAnkle", at: 0.433, units: 4.65, upper: false },
  { label: "foot-left", from: "leftHeel", to: "leftToe", at: 0.5, units: 1.45, upper: false },
  { label: "thigh-right", from: "rightHip", to: "rightKnee", at: 0.433, units: 10.0, upper: false },
  { label: "shank-right", from: "rightKnee", to: "rightAnkle", at: 0.433, units: 4.65, upper: false },
  { label: "foot-right", from: "rightHeel", to: "rightToe", at: 0.5, units: 1.45, upper: false },
];

/** Parcels above the hip joints. The Upper Mass Map's input. */
export const UPPER_PARCELS: readonly MassParcel[] = MASS_PARCELS.filter((p) => p.upper);

export const UPPER_MASS_UNITS = UPPER_PARCELS.reduce((sum, p) => sum + p.units, 0);
