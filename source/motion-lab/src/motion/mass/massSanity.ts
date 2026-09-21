/**
 * Checking the fore-aft mass reading against the body's own shape.
 *
 * WHY THE READING NEEDS CHECKING
 *
 * "Where is the mass between heel and toe" is the single most pitch-sensitive
 * number the whole pipeline produces. The mass centre sits about 920mm above
 * the ankles and the foot is about 265mm long, so a camera pitched one degree
 * slides the reading by 16mm -- six percent of the foot -- and nothing in the
 * picture looks wrong.
 *
 * Measured on the fixture: a five-degree pitch moved the reading from 77% of
 * the foot to 110%, and ten degrees to 143%. Meanwhile a golfer genuinely
 * sitting 60mm back moved it by 7%. The reading is roughly five times more
 * sensitive to the tripod than to the golfer.
 *
 * TWO CHECKS, AND NEITHER NEEDS THE CAMERA TO BE CALIBRATED
 *
 * 1. POSSIBILITY. A golfer standing on both feet has their centre of mass
 *    over their feet. Not as a matter of style -- as a matter of not falling
 *    over. So a reading beyond the toes or behind the heels is not a surprising
 *    measurement, it is an impossible one, and the amount by which it is
 *    impossible is a hard LOWER BOUND on the camera's pitch. At 110% of the
 *    foot the camera is pitched by at least 1.6 degrees; no other explanation
 *    is available.
 *
 *    Every planted frame gives such a bound, and they intersect. What comes
 *    out is an admissible interval, and the correction applied is the
 *    SMALLEST pitch inside it -- usually zero. Nothing is invented: the
 *    correction is exactly as large as the physics forces it to be and not a
 *    degree larger.
 *
 * 2. SHAPE. `observe/foreAft` splits the body's fore-aft profile into the
 *    part that is linear in height -- where a camera pitch lives, and where a
 *    whole-body lean lives with it -- and the BEND, which no camera angle can
 *    fake. The mass centre is a weighted sum of body points, so it splits the
 *    same way. `bendFractionUnit` is the mass position carried by the bend
 *    alone, and it moves 1.1mm per degree of pitch where the raw reading
 *    moves 16mm.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not assume a balanced golfer stands at any particular point on the
 * foot. The bound used is the whole foot, which is physics. Tightening it to
 * "a still golfer is near mid-foot" would make the pitch estimate several
 * times sharper and is almost certainly true -- but the synthetic fixture
 * cannot calibrate it, because its address posture leans forward without
 * pushing the hips back and so places the upper mass ahead of the toes. That
 * number has to come from real footage, and `fallingOverBoundary` is where it goes
 * when it does.
 *
 * It also does not report a pitch when nothing forces one. A clip whose mass
 * never leaves the foot is consistent with a level camera and with several
 * degrees of tilt, and saying so is the honest answer.
 */

import type { ClarityFrame, ClarityJoint, MassReading, MassSanity, Vec3 } from "../../contracts";
import {
  foreAftProfileOf,
  foreAftSlope,
  plantedIndices,
  toeDirection,
  type JointLookup,
} from "../../observe/foreAft";
import { buildMassCloud } from "./massModel";

/*
 * `MassReading` and `MassSanity` live in `contracts/` rather than here.
 *
 * They cross the boundary -- the 3D Space and the debug panel read the
 * verdict -- and `contracts/` may import nothing, so a type defined in this
 * file could never be named from there. The shapes are pure data; the
 * physics below is what stays in the Motion Layer.
 */

export interface MassSanityOptions {
  /**
   * Where on the foot a still golfer's mass is allowed to be, as a fraction
   * from heel to toe. The default is the whole foot, which is physics.
   *
   * Narrowing it sharpens the pitch estimate in proportion -- the band's
   * width divided by the mass height IS the uncertainty -- but it is a claim
   * about how people stand, so it stays a caller's decision and needs real
   * footage behind it. See the header.
   */
  readonly fallingOverBoundary?: readonly [number, number];
}

const WHOLE_FOOT: readonly [number, number] = [0, 1];
const DEG = 180 / Math.PI;

const midpointOf = (lookup: JointLookup, a: ClarityJoint, b: ClarityJoint): Vec3 | null => {
  const first = lookup(a);
  const second = lookup(b);
  if (!first || !second) return null;
  return [
    (first[0] + second[0]) / 2,
    (first[1] + second[1]) / 2,
    (first[2] + second[2]) / 2,
  ];
};

/**
 * The fore-aft mass reading for one body, and the pitch-free part of it.
 *
 * The mass centre is a weighted sum of points on the body, and removing a
 * term that is linear in height from every point removes the same term from
 * any weighted sum of them. So the bend-only mass position is just the mass
 * position with the profile's fitted slope taken out at the mass centre's own
 * height -- no second, parallel mass model required.
 */
export const readMass = (lookup: JointLookup): MassReading | null => {
  const joints = {} as Record<ClarityJoint, Vec3>;
  for (const joint of MASS_JOINTS) {
    const position = lookup(joint);
    if (!position) return null;
    joints[joint] = position;
  }

  const ankle = midpointOf(lookup, "leftAnkle", "rightAnkle");
  const heel = midpointOf(lookup, "leftHeel", "rightHeel");
  const toe = midpointOf(lookup, "leftToe", "rightToe");
  const forward = toeDirection(lookup);
  if (!ankle || !heel || !toe || !forward) return null;

  /*
   * Measured ALONG the feet, not along a world axis.
   *
   * Taking it as `toe.z - heel.z` assumes which way the toes point, and that
   * assumption is how a mirrored body went unnoticed through the whole
   * pipeline. Projected onto the direction the feet actually point, the span
   * is positive by construction and the fraction below means what it says
   * whichever way the world frame is turned.
   */
  const footSpanM =
    (toe[0] - heel[0]) * forward[0] + (toe[2] - heel[2]) * forward[2];
  if (footSpanM < 0.05) return null;

  const cloud = buildMassCloud(joints);
  let weightedX = 0;
  let weightedZ = 0;
  let height = 0;
  let total = 0;
  for (const parcel of cloud) {
    weightedX += parcel.position[0] * parcel.units;
    weightedZ += parcel.position[2] * parcel.units;
    height += parcel.position[1] * parcel.units;
    total += parcel.units;
  }
  if (total <= 0) return null;

  // How far the mass sits from the heel line, along the feet.
  const massAlongM =
    (weightedX / total - heel[0]) * forward[0] + (weightedZ / total - heel[2]) * forward[2];
  const massHeightM = height / total - ankle[1];

  const slope = foreAftSlope(foreAftProfileOf(lookup));
  const bendAlongM = massAlongM - slope * massHeightM;

  return {
    footFractionUnit: massAlongM / footSpanM,
    bendFractionUnit: bendAlongM / footSpanM,
    massHeightM,
    footSpanM,
  };
};

/** Every joint the mass cloud is built from. Missing any one means no reading. */
const MASS_JOINTS: readonly ClarityJoint[] = [
  "head", "neck", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
  "leftWrist", "rightWrist", "leftHand", "rightHand", "leftHip", "rightHip",
  "leftKnee", "rightKnee", "leftAnkle", "rightAnkle", "leftHeel", "rightHeel",
  "leftToe", "rightToe",
];

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const UNDETERMINED: MassSanity = {
  samples: 0,
  reading: { footFractionUnit: 0.5, bendFractionUnit: 0.5, massHeightM: 0, footSpanM: 0 },
  impossibleFrames: 0,
  pitchRangeDeg: [-90, 90],
  fallingOverPitchDeg: 0,
  correctedFootFractionUnit: 0.5,
  bendRangeM: 0,
  leanRangeM: 0,
  verdict: "undetermined",
  confidence: 0,
};

export const checkMassAgainstShape = (
  bodies: readonly JointLookup[],
  options: MassSanityOptions = {}
): MassSanity => {
  const [low, high] = options.fallingOverBoundary ?? WHOLE_FOOT;

  const readings: MassReading[] = [];
  for (const index of plantedIndices(bodies)) {
    const reading = readMass(bodies[index]);
    if (reading) readings.push(reading);
  }
  if (readings.length === 0) return UNDETERMINED;

  /*
   * The admissible pitch, as an interval.
   *
   * Removing a pitch t = tan(theta) moves the reading to
   * `fraction - t * massHeight / footSpan`, monotonically. Requiring that to
   * land inside the balance band turns each frame into one interval on t, and
   * the clip's answer is their intersection. No search, no fitting.
   */
  let lower = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  let impossibleFrames = 0;

  for (const reading of readings) {
    const lever = reading.massHeightM / reading.footSpanM;
    if (!Number.isFinite(lever) || Math.abs(lever) < 1e-6) continue;
    lower = Math.max(lower, (reading.footFractionUnit - high) / lever);
    upper = Math.min(upper, (reading.footFractionUnit - low) / lever);
    if (reading.footFractionUnit < low || reading.footFractionUnit > high) {
      impossibleFrames += 1;
    }
  }

  const irreconcilable = lower > upper;
  // The smallest correction the interval permits. Zero whenever a level
  // camera is still on the table, which is the common and correct answer.
  const chosen = irreconcilable ? 0 : lower > 0 ? lower : upper < 0 ? upper : 0;
  const fallingOverPitchDeg = Math.atan(chosen) * DEG;

  const reading: MassReading = {
    footFractionUnit: median(readings.map((r) => r.footFractionUnit)),
    bendFractionUnit: median(readings.map((r) => r.bendFractionUnit)),
    massHeightM: median(readings.map((r) => r.massHeightM)),
    footSpanM: median(readings.map((r) => r.footSpanM)),
  };

  const spread = (pick: (r: MassReading) => number): number => {
    const values = readings.map(pick);
    return (Math.max(...values) - Math.min(...values)) * reading.footSpanM;
  };
  const bendRangeM = spread((r) => r.bendFractionUnit);
  const leanRangeM = spread((r) => r.footFractionUnit - r.bendFractionUnit);

  /*
   * Confidence in the CORRECTED reading.
   *
   * Two things spend it. A wide admissible interval means the clip never got
   * near enough to the edge of the foot to pin the camera down, so the
   * absolute reading could still be several degrees out. Frames that were
   * outright impossible mean something was wrong before the correction, and
   * the correction only guarantees they are no longer impossible -- not that
   * they are right.
   */
  const rangeDeg = irreconcilable
    ? 180
    : Math.atan(Math.min(upper, 10)) * DEG - Math.atan(Math.max(lower, -10)) * DEG;
  const pinned = Math.max(0, 1 - rangeDeg / 16);
  const clean = 1 - impossibleFrames / readings.length;
  const confidence = irreconcilable ? 0 : Math.max(0, Math.min(1, pinned * 0.6 + clean * 0.4));

  return {
    samples: readings.length,
    reading,
    impossibleFrames,
    pitchRangeDeg: [
      Number.isFinite(lower) ? Math.atan(lower) * DEG : -90,
      Number.isFinite(upper) ? Math.atan(upper) * DEG : 90,
    ],
    fallingOverPitchDeg,
    correctedFootFractionUnit:
      reading.footFractionUnit - chosen * (reading.massHeightM / reading.footSpanM),
    bendRangeM,
    leanRangeM,
    verdict: irreconcilable
      ? "irreconcilable"
      : Math.abs(fallingOverPitchDeg) > 0.05
        ? "corrected"
        : "consistent",
    confidence,
  };
};

/**
 * The bodies in a sequence this check is allowed to read.
 *
 * ONLY FRAMES WHOSE FEET WERE ACTUALLY SEEN.
 *
 * A reconstructed foot is a guess about where a foot was, and the whole
 * argument here rests on the feet being the one thing in the picture we can
 * trust -- the support polygon is the yardstick the mass is measured against.
 * Measuring an invented mass position against an invented foot would produce
 * a number with no evidence anywhere in it, and it would look exactly like a
 * real one.
 *
 * `constrained` is admitted alongside `observed`: the joint was seen, and the
 * solver moved it to keep the body coherent. `reconstructed` and
 * `extrapolated` are not, because nobody saw them.
 */
export const checkableBodies = (frames: readonly ClarityFrame[]): readonly JointLookup[] =>
  frames
    .filter(
      (frame) =>
        frame.mass !== null &&
        FOOT_JOINTS.every((joint) => {
          const source = frame.provenance.joints[joint].source;
          return source === "observed" || source === "constrained";
        })
    )
    .map((frame) => (joint: ClarityJoint) => frame.body.joints[joint]);

const FOOT_JOINTS: readonly ClarityJoint[] = [
  "leftHeel",
  "rightHeel",
  "leftToe",
  "rightToe",
];
