/**
 * Separating a camera's pitch from the golfer's posture.
 *
 * THE PROBLEM
 *
 * `anchor.ts` levels the world from the stance line, which fixes the ROLL --
 * the tilt around the optical axis. One line gives one constraint, so the
 * PITCH, the tilt up or down, is left untouched. Nothing in a single still
 * frame can measure it, because a camera tilted down and a golfer leaning
 * forward produce the same picture.
 *
 * It is not a small residue. A pitch of theta adds `h*tan(theta)` to the
 * fore-aft position of everything at height h: at two degrees that is 2mm at
 * the ankle, 33mm at the hip and 51mm at the shoulder. Every fore-aft signal
 * -- where the mass sits between heel and toe above all -- inherits it.
 *
 * THE NAIVE TEST, AND WHY IT FAILS
 *
 * The tempting move is to regress fore-aft position on height: the camera's
 * contribution is exactly linear in height, so the slope should be the pitch.
 *
 * It is not, and the reason is anatomy. A golfer at address pushes the hips
 * BACK and tilts the spine FORWARD over them. Hips back and shoulders forward
 * is not a flat profile -- the shoulders and head are further from the ankle
 * than the hips are, and they are also higher, so the posture ITSELF
 * correlates with height. Regressing on this fixture's address posture gives
 * a slope of 3.3 degrees with the camera perfectly level. A naive height
 * regression would report a level camera as tilted, and then "correct" a
 * golfer's genuine address out of the data.
 *
 * WHAT ACTUALLY SEPARATES THEM
 *
 * Not the slope -- the SHAPE.
 *
 * A camera pitch adds a term that is linear in height and nothing else. So
 * whatever is left of the fore-aft profile after the best straight line
 * through it has been removed cannot contain any camera pitch at all. That is
 * not a heuristic that mostly works; it is arithmetic. Adding `t0*h` to every
 * point raises the fitted slope by exactly `t0` and leaves every residual
 * bit-for-bit identical.
 *
 * And the residual is where the golf is. Hips back against shoulders forward
 * is a bend in the profile, not a slope, so it survives the fit intact:
 * `hipSetBackM` measures how far the hips sit behind the straight line from
 * ankle to shoulder, and that is a shape no camera angle can fake.
 *
 * WHAT THIS BUYS, AND WHAT IT DOES NOT
 *
 * It buys a squat measurement that needs no camera calibration whatsoever.
 * Pushing the hips back is the main thing a golfer's lower body does, and it
 * is now measurable without knowing, or estimating, the camera's pitch.
 *
 * It does NOT buy the pitch. `apparentLeanDeg` is pitch plus genuine
 * whole-body lean and the two are not separable from one posture -- so it is
 * named for what it is. What the module can say about the pitch is whether
 * the fore-aft reading is CONTAMINATED by it: `linearFractionUnit` reports
 * how much of the profile a camera tilt alone could account for. Near one
 * means the golfer's fore-aft shape is indistinguishable from a tilt and any
 * absolute heel/toe number should be distrusted. Well below one means there
 * is real posture structure, and the residual part of it is exact.
 */

import type { ClarityJoint, Vec3 } from "../contracts";
import type { WorldObservationFrame, WorldObservationSequence } from "./observation";

/**
 * The joints the profile is built from, lowest first.
 *
 * Midpoints of the two sides, because the fore-aft question is about the body
 * as a whole and the left/right difference is the stance, measured elsewhere.
 * Paired joints average away a good deal of per-landmark noise for free.
 */
const CHAIN: readonly {
  readonly name: string;
  readonly from: readonly ClarityJoint[];
}[] = [
  { name: "ankle", from: ["leftAnkle", "rightAnkle"] },
  { name: "knee", from: ["leftKnee", "rightKnee"] },
  { name: "hip", from: ["leftHip", "rightHip"] },
  { name: "shoulder", from: ["leftShoulder", "rightShoulder"] },
  { name: "head", from: ["head"] },
];

/**
 * How much more a frame's feet may splay than the clip's own planted
 * baseline before it counts as a heel lift rather than a stance.
 */
const HEEL_LIFT_TOLERANCE_M = 0.02;

const FOOT_JOINTS: readonly ClarityJoint[] = [
  "leftHeel",
  "leftToe",
  "rightHeel",
  "rightToe",
];

/** One rung of the chain: how high it is, and how far forward. */
export interface ForeAftSample {
  readonly name: string;
  /** Metres above the ankle. */
  readonly heightM: number;
  /** Metres toward the toes, relative to the ankle. */
  readonly foreAftM: number;
}

export interface PostureShape {
  readonly samples: readonly ForeAftSample[];
  /**
   * Fore-aft lean of the body as the camera sees it, degrees, positive
   * toward the toes.
   *
   * NOT the camera pitch, and not the golfer's lean either: it is their sum,
   * and one frame cannot take them apart. Its value is that it is the ONLY
   * place the pitch hides -- everything else this type reports is free of it.
   */
  readonly apparentLeanDeg: number;
  /**
   * How far the hips sit BEHIND the line from ankle to shoulder, metres.
   * Positive is behind, toward the heels, which is what a golfer does.
   *
   * Nearly immune to camera pitch: exactly immune to the shear a pitch
   * applies, and left with only the second-order part of a true rotation.
   * Measured on the synthetic fixture, five degrees of pitch moved this by
   * 2.8mm where it moved the hips' raw position relative to the ankles by
   * 76mm -- and a real 60mm squat moves it by 51mm.
   *
   * NOT the same quantity as "how far are the hips behind the ankles". That
   * one is 15mm per degree of pitch and cannot be measured without knowing
   * the pitch; this is the BEND in the profile, which can.
   */
  readonly hipSetBackM: number;
  /** How far the knees sit AHEAD of that line. Positive is toward the toes. */
  readonly kneeOverM: number;
  /** How far the head sits ahead of it. Positive is toward the toes. */
  readonly headOverM: number;
  /**
   * The fraction of the fore-aft profile a camera pitch alone could explain,
   * 0..1. High means the posture is shaped like a tilt and absolute fore-aft
   * readings are not safe; low means there is structure no tilt can fake.
   */
  readonly linearFractionUnit: number;
  /** Height spanned by the samples, metres. The lever the fit has to work with. */
  readonly spanM: number;
}

const midpoint = (
  frame: WorldObservationFrame,
  joints: readonly ClarityJoint[]
): Vec3 | null => {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const joint of joints) {
    const observed = frame.joints[joint];
    if (!observed) return null;
    x += observed.position[0];
    y += observed.position[1];
    z += observed.position[2];
  }
  return [x / joints.length, y / joints.length, z / joints.length];
};

/**
 * The fore-aft profile of one frame, measured from the ankle.
 *
 * Everything is relative to the ankle so the model has no intercept to fit.
 * That is not tidiness: an intercept would absorb a translation, and a
 * translation is exactly what the anchoring step has already removed. Fitting
 * one again would let frame-to-frame anchoring noise leak into the slope.
 */
export const foreAftProfile = (
  frame: WorldObservationFrame
): readonly ForeAftSample[] => {
  const ankle = midpoint(frame, CHAIN[0].from);
  if (!ankle) return [];

  const samples: ForeAftSample[] = [];
  for (const rung of CHAIN) {
    const point = midpoint(frame, rung.from);
    if (!point) continue;
    samples.push({
      name: rung.name,
      heightM: point[1] - ankle[1],
      foreAftM: point[2] - ankle[2],
    });
  }
  return samples;
};

/** Slope of the best line through the origin: the camera's share, plus lean. */
const fitSlope = (samples: readonly ForeAftSample[]): number => {
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += sample.heightM * sample.foreAftM;
    denominator += sample.heightM * sample.heightM;
  }
  return denominator > 1e-9 ? numerator / denominator : 0;
};

/**
 * What is left of the profile once every possible camera pitch is removed.
 *
 * The returned offsets are the pitch-invariant part. Adding `t0*h` to every
 * sample raises `fitSlope` by exactly `t0` and leaves these untouched, which
 * is the whole point of the module.
 */
export const pitchInvariantOffsets = (
  samples: readonly ForeAftSample[]
): ReadonlyMap<string, number> => {
  const slope = fitSlope(samples);
  const offsets = new Map<string, number>();
  for (const sample of samples) {
    offsets.set(sample.name, sample.foreAftM - slope * sample.heightM);
  }
  return offsets;
};

/** An empty shape, for frames the chain cannot be built from. */
const NO_SHAPE: PostureShape = {
  samples: [],
  apparentLeanDeg: 0,
  hipSetBackM: 0,
  kneeOverM: 0,
  headOverM: 0,
  linearFractionUnit: 1,
  spanM: 0,
};

export const postureShape = (frame: WorldObservationFrame): PostureShape => {
  const samples = foreAftProfile(frame);
  // Three rungs is the minimum that can distinguish a bend from a slope: two
  // points define the line the third is measured against.
  if (samples.length < 3) return NO_SHAPE;

  const slope = fitSlope(samples);
  const offsets = pitchInvariantOffsets(samples);

  let residualSq = 0;
  let totalSq = 0;
  for (const sample of samples) {
    const residual = offsets.get(sample.name) ?? 0;
    residualSq += residual * residual;
    totalSq += sample.foreAftM * sample.foreAftM;
  }

  const heights = samples.map((sample) => sample.heightM);
  return {
    samples,
    apparentLeanDeg: (Math.atan(slope) * 180) / Math.PI,
    // Negated: the offsets are measured toward the toes, and a golfer's hips
    // going BACK is the interesting direction, so it is the positive one.
    hipSetBackM: -(offsets.get("hip") ?? 0),
    kneeOverM: offsets.get("knee") ?? 0,
    headOverM: offsets.get("head") ?? 0,
    linearFractionUnit: totalSq > 1e-9 ? Math.max(0, 1 - residualSq / totalSq) : 1,
    spanM: Math.max(...heights) - Math.min(...heights),
  };
};

/* --------------------------- over a sequence -------------------------- */

/**
 * How far this frame's foot points are from lying in one plane, metres.
 *
 * MEASURED AS A SPREAD, NOT AS A HEIGHT ABOVE THE GROUND.
 *
 * The obvious test -- every foot point within a few centimetres of Y = 0 --
 * fails on exactly the clips this module exists for. A camera pitched by
 * theta raises the toes above the heels by `footLength * sin(theta)`, which
 * at ten degrees is 35mm on a 200mm foot: enough to fail any sane ground
 * tolerance on EVERY frame. The filter would then silently return no
 * samples, and a pitch measurement that vanishes when the pitch gets large
 * is worse than none at all.
 *
 * The spread does not care. Pitch adds the same splay to every frame in the
 * clip, so comparing each frame against the clip's own flattest frames
 * removes it, while a heel coming up -- which is a CHANGE -- still shows.
 */
const footSpread = (frame: WorldObservationFrame): number | null => {
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const joint of FOOT_JOINTS) {
    const observed = frame.joints[joint];
    if (!observed) return null;
    lowest = Math.min(lowest, observed.position[1]);
    highest = Math.max(highest, observed.position[1]);
  }
  return highest - lowest;
};

export interface ForeAftSeparation {
  /** The averaged shape over every usable frame. */
  readonly shape: PostureShape;
  readonly samples: number;
  /**
   * How far `apparentLeanDeg` moved across the clip, degrees.
   *
   * The camera's pitch is the SAME in every frame, so anything that changes
   * is the golfer. A clip whose apparent lean never varies has given no
   * evidence about how much of it is posture.
   */
  readonly leanRangeDeg: number;
  /**
   * True when the residual carries enough of the profile, over enough height,
   * for the pitch-invariant numbers to mean something.
   */
  readonly separable: boolean;
}

const MIN_SPAN_M = 0.8;
/** Above this, the profile is shaped like a tilt and the residual is noise. */
const MAX_LINEAR_FRACTION = 0.97;

export const separateForeAft = (
  sequence: WorldObservationSequence
): ForeAftSeparation => {
  /*
   * The clip's own planted baseline: the 20th-percentile foot splay. Low
   * enough to exclude the takeaway, high enough that it is a real frame
   * rather than the one the detector got luckiest on.
   */
  const spreads: number[] = [];
  for (const frame of sequence.frames) {
    if (!frame.detected) continue;
    const spread = footSpread(frame);
    if (spread !== null) spreads.push(spread);
  }
  spreads.sort((a, b) => a - b);
  const planted =
    spreads.length > 0 ? spreads[Math.floor(spreads.length * 0.2)] : Number.POSITIVE_INFINITY;

  const shapes: PostureShape[] = [];
  for (const frame of sequence.frames) {
    if (!frame.detected) continue;
    const spread = footSpread(frame);
    if (spread === null || spread > planted + HEEL_LIFT_TOLERANCE_M) continue;
    const shape = postureShape(frame);
    if (shape.samples.length >= 3) shapes.push(shape);
  }

  if (shapes.length === 0) {
    return { shape: NO_SHAPE, samples: 0, leanRangeDeg: 0, separable: false };
  }

  /*
   * The MEDIAN of each quantity, not the mean.
   *
   * The flat-footed set runs from address through the takeaway, and the
   * moment a heel starts to leave the ground that foot pivots about its toe
   * while still passing the tolerance. Those frames sit at one end of the
   * range, so a mean is dragged toward the takeaway and the median is not.
   */
  const medianOf = (pick: (shape: PostureShape) => number): number => {
    const values = shapes.map(pick).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };

  const leans = shapes.map((shape) => shape.apparentLeanDeg);
  const shape: PostureShape = {
    samples: shapes[Math.floor(shapes.length / 2)].samples,
    apparentLeanDeg: medianOf((s) => s.apparentLeanDeg),
    hipSetBackM: medianOf((s) => s.hipSetBackM),
    kneeOverM: medianOf((s) => s.kneeOverM),
    headOverM: medianOf((s) => s.headOverM),
    linearFractionUnit: medianOf((s) => s.linearFractionUnit),
    spanM: medianOf((s) => s.spanM),
  };

  return {
    shape,
    samples: shapes.length,
    leanRangeDeg: Math.max(...leans) - Math.min(...leans),
    separable:
      shape.spanM >= MIN_SPAN_M && shape.linearFractionUnit <= MAX_LINEAR_FRACTION,
  };
};
