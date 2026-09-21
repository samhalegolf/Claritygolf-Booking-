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
 * number has to come from real footage, and `balanceBand` is where it goes
 * when it does.
 *
 * It also does not report a pitch when nothing forces one. A clip whose mass
 * never leaves the foot is consistent with a level camera and with several
 * degrees of tilt, and saying so is the honest answer.
 */

import type { ClarityJoint, Unit, Vec3 } from "../../contracts";
import {
  foreAftProfileOf,
  foreAftSlope,
  plantedIndices,
  type JointLookup,
} from "../../observe/foreAft";
import { buildMassCloud } from "./massModel";

/** The fore-aft mass reading for one body. */
export interface MassReading {
  /** Where the mass sits between the heel line (0) and the toe line (1). */
  readonly footFractionUnit: number;
  /**
   * The same reading with every possible camera pitch removed.
   *
   * This is the mass position relative to the golfer's own stacked axis --
   * what their BEND puts there, with any whole-body lean taken out along with
   * the camera. It is not "where the mass really is"; it is the part of where
   * the mass is that a camera cannot have invented.
   */
  readonly bendFractionUnit: number;
  /** Height of the mass centre above the ankles. The lever a pitch works through. */
  readonly massHeightM: number;
  /** Heel to toe, metres. */
  readonly footSpanM: number;
}

export interface MassSanity {
  /** Planted frames the check ran over. */
  readonly samples: number;
  /** The median reading across those frames. */
  readonly reading: MassReading;
  /** Frames whose mass fell outside the feet, which a standing golfer's cannot. */
  readonly impossibleFrames: number;
  /**
   * The camera pitches consistent with every planted frame, degrees.
   * Unbounded ends are reported as +/- 90.
   */
  readonly pitchRangeDeg: readonly [number, number];
  /**
   * The smallest pitch inside that range, degrees. Zero whenever a level
   * camera is possible -- which is most of the time, and is the point.
   */
  readonly minimumPitchDeg: number;
  /** The reading after applying `minimumPitchDeg`. */
  readonly correctedFootFractionUnit: number;
  /**
   * How far the BEND moved the mass across the clip, metres.
   *
   * Pitch-free twice over: the bend is pitch-free, and a range is a set of
   * differences, which a constant pitch cancels out of anyway.
   */
  readonly bendRangeM: number;
  /**
   * How far the whole-body LEAN moved it, metres. Also pitch-free as a range,
   * though its absolute value is not.
   */
  readonly leanRangeM: number;
  readonly verdict: "consistent" | "corrected" | "irreconcilable" | "undetermined";
  /** Confidence in the corrected reading, after everything above. */
  readonly confidence: Unit;
}

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
  readonly balanceBand?: readonly [number, number];
}

const DEFAULT_BAND: readonly [number, number] = [0, 1];
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
  if (!ankle || !heel || !toe) return null;

  const footSpanM = toe[2] - heel[2];
  if (Math.abs(footSpanM) < 0.05) return null;

  const cloud = buildMassCloud(joints);
  let weighted = 0;
  let height = 0;
  let total = 0;
  for (const parcel of cloud) {
    weighted += parcel.position[2] * parcel.units;
    height += parcel.position[1] * parcel.units;
    total += parcel.units;
  }
  if (total <= 0) return null;

  const massZ = weighted / total;
  const massHeightM = height / total - ankle[1];

  const slope = foreAftSlope(foreAftProfileOf(lookup));
  const bendZ = massZ - slope * massHeightM;

  return {
    footFractionUnit: (massZ - heel[2]) / footSpanM,
    bendFractionUnit: (bendZ - heel[2]) / footSpanM,
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
  minimumPitchDeg: 0,
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
  const [low, high] = options.balanceBand ?? DEFAULT_BAND;

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
  const minimumPitchDeg = Math.atan(chosen) * DEG;

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
    minimumPitchDeg,
    correctedFootFractionUnit:
      reading.footFractionUnit - chosen * (reading.massHeightM / reading.footSpanM),
    bendRangeM,
    leanRangeM,
    verdict: irreconcilable
      ? "irreconcilable"
      : Math.abs(minimumPitchDeg) > 0.05
        ? "corrected"
        : "consistent",
    confidence,
  };
};
