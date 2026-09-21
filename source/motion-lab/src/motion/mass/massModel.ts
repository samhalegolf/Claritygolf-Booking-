/**
 * The mass and support model.
 *
 * Two deliberately separate questions, which the plan is careful to keep
 * apart and which this file keeps apart too:
 *
 *   UPPER MASS MAP      "where is the mass in the air positioned?"
 *                       The body from the hip joints up, projected straight
 *                       down. It need not land under either foot, and it is
 *                       not constrained to.
 *
 *   ESTIMATED SUPPORT   "where does supported weight reach the ground?"
 *                       Constrained into the actual foot contact polygon,
 *                       because weight cannot be borne through thin air.
 *
 * What this is NOT: force-plate data. No rotational or torsional force is
 * modelled, no pressure is measured, and nothing here should ever be
 * presented as though it were. The estimator is quasi-static -- it places
 * support beneath the centre of mass and clamps it into the contact polygon.
 * During a fast transition that is an approximation, and its confidence says
 * so rather than the number pretending otherwise.
 */

import type { ClarityJoint, MassCloudPoint, MassEstimate, Unit, Vec3 } from "../../contracts";
import {
  clampUnit,
  distance,
  dot,
  lerpVec,
  normalise,
  projectToGround,
  sub,
  weightedCentroid,
} from "../../contracts";
import { MASS_PARCELS, TOTAL_MASS_UNITS, UPPER_PARCELS } from "./segmentMass";

export interface MassModelInput {
  readonly joints: Readonly<Record<ClarityJoint, Vec3>>;
  /** Stance width at the world-frame anchor, metres. Normalises separation. */
  readonly stanceWidthM: number;
  /**
   * How close to the ground a foot point must be to count as bearing weight.
   * A lifting heel genuinely leaves the support polygon, and letting it do so
   * is the difference between an estimate and a decoration.
   */
  readonly groundContactToleranceM?: number;
  /**
   * Per-joint support, 0..1 -- how much of each joint came from observation.
   * Mass confidence inherits from the geometry it was computed over, so a
   * mass centre built on a reconstructed pelvis does not read as certain.
   */
  readonly jointSupport?: Readonly<Partial<Record<ClarityJoint, Unit>>>;
}

const DEFAULT_CONTACT_TOLERANCE_M = 0.035;

const FOOT_CONTACT_JOINTS: readonly ClarityJoint[] = [
  "leftHeel",
  "leftToe",
  "rightHeel",
  "rightToe",
];

/* ------------------------- polygon geometry ------------------------- */

/** Cross product of OA and OB in the XZ plane. Sign gives the turn direction. */
const crossXZ = (o: Vec3, a: Vec3, b: Vec3): number =>
  (a[0] - o[0]) * (b[2] - o[2]) - (a[2] - o[2]) * (b[0] - o[0]);

/**
 * Convex hull in the XZ plane, Andrew's monotone chain.
 *
 * The support polygon is the hull of whichever foot points are actually on
 * the ground -- which may be four points, two (one foot), or none at all
 * during a jump or an extreme follow-through.
 */
export const convexHullXZ = (points: readonly Vec3[]): Vec3[] => {
  if (points.length <= 2) return points.map((p) => projectToGround(p));

  const sorted = points
    .map((p) => projectToGround(p))
    .sort((a, b) => (a[0] === b[0] ? a[2] - b[2] : a[0] - b[0]));

  const build = (source: Vec3[]): Vec3[] => {
    const chain: Vec3[] = [];
    for (const point of source) {
      while (chain.length >= 2 && crossXZ(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) {
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };

  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  const hull = [...lower, ...upper];

  // Degenerate input -- all points collinear -- collapses the hull. Fall back
  // to the extremes so the polygon is still a usable segment.
  if (hull.length < 3) return [sorted[0], sorted[sorted.length - 1]];
  return hull;
};

const pointInPolygonXZ = (point: Vec3, polygon: readonly Vec3[]): boolean => {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const zi = polygon[i][2];
    const xj = polygon[j][0];
    const zj = polygon[j][2];
    const intersects =
      zi > point[2] !== zj > point[2] &&
      point[0] < ((xj - xi) * (point[2] - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

const closestPointOnSegmentXZ = (point: Vec3, a: Vec3, b: Vec3): Vec3 => {
  const ab = sub(b, a);
  const lenSq = ab[0] * ab[0] + ab[2] * ab[2];
  if (lenSq < 1e-12) return projectToGround(a);
  const ap = sub(point, a);
  const t = Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[2] * ab[2]) / lenSq));
  return projectToGround(lerpVec(a, b, t));
};

/**
 * The closest point to `point` that lies inside `polygon`.
 *
 * This is the clamp that makes the support estimate physically honest: the
 * centre of mass may be well outside the feet, but the support centre cannot
 * be, so it is pinned to the polygon boundary rather than allowed to float.
 */
export const constrainToPolygonXZ = (point: Vec3, polygon: readonly Vec3[]): Vec3 => {
  if (polygon.length === 0) return projectToGround(point);
  if (polygon.length === 1) return projectToGround(polygon[0]);
  if (pointInPolygonXZ(point, polygon)) return projectToGround(point);

  let best = closestPointOnSegmentXZ(point, polygon[0], polygon[1 % polygon.length]);
  let bestDistance = distance(projectToGround(point), best);
  for (let i = 1; i < polygon.length; i += 1) {
    const candidate = closestPointOnSegmentXZ(
      point,
      polygon[i],
      polygon[(i + 1) % polygon.length]
    );
    const candidateDistance = distance(projectToGround(point), candidate);
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return best;
};

/* --------------------------- the estimate --------------------------- */

const parcelPosition = (
  joints: Readonly<Record<ClarityJoint, Vec3>>,
  from: ClarityJoint,
  to: ClarityJoint,
  at: number
): Vec3 => lerpVec(joints[from], joints[to], at);

/** The weighted mass cloud attached to the current body geometry. */
export const buildMassCloud = (
  joints: Readonly<Record<ClarityJoint, Vec3>>
): MassCloudPoint[] =>
  MASS_PARCELS.map((parcel) => ({
    label: parcel.label,
    position: parcelPosition(joints, parcel.from, parcel.to, parcel.at),
    units: parcel.units,
    upper: parcel.upper,
  }));

export const estimateMass = (input: MassModelInput): MassEstimate => {
  const { joints, stanceWidthM } = input;
  const tolerance = input.groundContactToleranceM ?? DEFAULT_CONTACT_TOLERANCE_M;

  const cloud = buildMassCloud(joints);

  // Upper mass: hip joints and above, projected straight down. Deliberately
  // unconstrained -- "where is the mass in the air" is allowed to be an
  // answer that sits outside the feet.
  const upperPositions = UPPER_PARCELS.map((parcel) =>
    parcelPosition(joints, parcel.from, parcel.to, parcel.at)
  );
  const upperWeights = UPPER_PARCELS.map((parcel) => parcel.units);
  const upperMassCentre = weightedCentroid(upperPositions, upperWeights);
  const upperMassGround = projectToGround(upperMassCentre);

  // Whole-body centre of mass. Support is placed beneath this, then clamped.
  const wholeBodyCentre = weightedCentroid(
    cloud.map((point) => point.position),
    cloud.map((point) => point.units)
  );

  // Which foot points are actually bearing weight. A lifted heel drops out,
  // which shrinks the polygon and moves the support centre onto the toes --
  // the physically right answer rather than a convenient one.
  const contactPoints = FOOT_CONTACT_JOINTS.filter(
    (joint) => joints[joint][1] <= tolerance
  ).map((joint) => joints[joint]);

  const supportPolygon = contactPoints.length > 0 ? convexHullXZ(contactPoints) : [];
  const supportCentre =
    supportPolygon.length > 0
      ? constrainToPolygonXZ(projectToGround(wholeBodyCentre), supportPolygon)
      : projectToGround(wholeBodyCentre);

  // The stance line is measured from the current feet, not assumed. Positive
  // separation is toward the right foot.
  const leftFoot = joints.leftAnkle;
  const rightFoot = joints.rightAnkle;
  const stanceAxis = normalise(projectToGround(sub(rightFoot, leftFoot)));
  const separationVector = sub(upperMassGround, supportCentre);
  const effectiveStanceWidth = stanceWidthM > 1e-3 ? stanceWidthM : 1;
  const normalisedSeparation = dot(separationVector, stanceAxis) / effectiveStanceWidth;

  const footShare = distributeFootLoad(supportCentre, joints, contactPoints.length);

  return {
    upperMassCentre,
    upperMassGround,
    supportCentre,
    normalisedSeparation,
    footShare,
    supportPolygon,
    cloud,
    confidence: massConfidence(input, contactPoints.length),
  };
};

/**
 * How the pot splits between the feet.
 *
 * The support centre is projected onto the line between the two foot centres
 * and the share falls out of where it lands. With one foot in contact that
 * foot takes everything; with none, the split is reported as even and the
 * confidence is zero, because an even split is not a claim -- it is the
 * absence of one.
 */
const distributeFootLoad = (
  supportCentre: Vec3,
  joints: Readonly<Record<ClarityJoint, Vec3>>,
  contactCount: number
): { left: Unit; right: Unit } => {
  if (contactCount === 0) return { left: 0.5, right: 0.5 };

  const leftCentre = projectToGround(lerpVec(joints.leftHeel, joints.leftToe, 0.5));
  const rightCentre = projectToGround(lerpVec(joints.rightHeel, joints.rightToe, 0.5));
  const axis = sub(rightCentre, leftCentre);
  const axisLengthSq = axis[0] * axis[0] + axis[2] * axis[2];
  if (axisLengthSq < 1e-9) return { left: 0.5, right: 0.5 };

  const offset = sub(supportCentre, leftCentre);
  const t = clampUnit((offset[0] * axis[0] + offset[2] * axis[2]) / axisLengthSq);
  return { left: clampUnit(1 - t), right: clampUnit(t) };
};

/**
 * Confidence in the mass estimate.
 *
 * It inherits from the geometry: mass computed over a heavily reconstructed
 * body is a heavily reconstructed answer. With no foot on the ground there is
 * no support estimate to have confidence in, so it goes to zero rather than
 * reporting the unclamped centre of mass as though it were support.
 */
const massConfidence = (input: MassModelInput, contactCount: number): Unit => {
  const support = input.jointSupport;
  if (!support) return contactCount > 0 ? 0.5 : 0;

  const relevant = MASS_PARCELS.flatMap((parcel) => [
    support[parcel.from] ?? 0,
    support[parcel.to] ?? 0,
  ]);
  const geometryConfidence =
    relevant.length === 0
      ? 0
      : relevant.reduce((sum, value) => sum + value, 0) / relevant.length;

  if (contactCount === 0) return 0;
  // Two contact points barely define a polygon; four is a full stance.
  const contactConfidence = clampUnit(contactCount / FOOT_CONTACT_JOINTS.length);
  return clampUnit(geometryConfidence * 0.7 + contactConfidence * 0.3);
};

export { TOTAL_MASS_UNITS };
