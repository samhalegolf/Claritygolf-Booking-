/**
 * Context bids: how much an observation should count RIGHT NOW, from where
 * the camera was and what was in its way.
 *
 * WHAT A CONTEXT BID IS, AND WHAT IT IS NOT
 *
 * Every other stage asks whether an observation is RIGHT -- against the
 * bones, against its neighbours in time. A context bid asks something
 * earlier: how good a witness was the detector for this joint on this frame?
 * It never says where a joint should be. It only changes how hard the joint
 * holds its ground when the bones and the other joints disagree with it.
 *
 * Both bids here come from the camera and the body. Neither knows anything
 * about golf, so a strange swing filmed cleanly keeps all of its evidence.
 *
 * 1. THE LINE OF SIGHT
 *
 *    A detector places a point well ACROSS the picture and badly along the
 *    line of sight, because depth is the one axis the image does not contain.
 *    So a joint's observation is not trusted less overall -- it is trusted
 *    less in ONE DIRECTION. When a bone disagrees with it, the fix moves it
 *    toward or away from the lens before it moves it sideways.
 *
 *    How much worse depth is, is measured off this clip, per joint: the
 *    frame-to-frame jitter along the line of sight against the jitter across
 *    it. Clean depth measures a ratio of one and changes nothing.
 *
 * 2. HIDDEN BY THE BODY
 *
 *    A joint behind another part of the golfer, as the camera saw it, is a
 *    detector's guess at something it could not see. The reconstructed body
 *    says what was in front: the far hip behind the near one down the line,
 *    an elbow behind the chest. A hidden joint holds its ground less, in
 *    every direction.
 *
 *    How much less is measured too: the jitter of hidden samples against
 *    visible ones, pooled over the clip. If being hidden made the detector no
 *    worse on this clip, the bid does nothing.
 *
 * BOTH ONLY EVER TAKE TRUST AWAY. A factor of 1 is the default, so a clip
 * with no camera fit, or with nothing to measure, reconstructs exactly as it
 * did before this file existed.
 */

import type { ClarityJoint, Unit, Vec3 } from "../../contracts";
import { CLARITY_JOINTS, clamp, clampUnit, distance, dot, normalise, scale, sub } from "../../contracts";
import type { Camera } from "../club/camera";
import type { Tracks } from "./tracks";

/* ------------------------------------------------------------------ *
 * The camera
 * ------------------------------------------------------------------ */

/**
 * Below this, a per-frame camera fit was taken from a body too flat to pin
 * it, and its centre can sit anywhere along a line.
 */
const MIN_CAMERA_CONDITIONING = 0.5;

/**
 * Where the camera was, per frame, in world metres.
 *
 * A frame's own fit when it was well conditioned, otherwise the clip median
 * of the good ones. The median is a fine stand-in: a direction to a joint
 * three metres away barely moves when the centre is off by a hand's width,
 * and a tripod does not move at all.
 *
 * Null for every frame when no frame fitted well -- and then there is no
 * line of sight and no "in front", so both bids stand aside.
 */
export const cameraCentres = (cameras: readonly (Camera | null)[]): (Vec3 | null)[] => {
  const good = cameras.filter(
    (camera): camera is Camera => camera !== null && camera.conditioning >= MIN_CAMERA_CONDITIONING
  );
  if (good.length === 0) return cameras.map(() => null);

  const median = (axis: 0 | 1 | 2) => {
    const values = good.map((camera) => camera.centre[axis]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const fallback: Vec3 = [median(0), median(1), median(2)];

  return cameras.map((camera) =>
    camera && camera.conditioning >= MIN_CAMERA_CONDITIONING ? camera.centre : fallback
  );
};

/* ------------------------------------------------------------------ *
 * Robust jitter
 * ------------------------------------------------------------------ */

/**
 * The same statistic `estimateNoise` uses -- a low percentile of the
 * second difference -- so genuine acceleration, which lives in the upper
 * tail, does not read as noise. The constants turn that percentile back into
 * a standard deviation for the shape of the sample: a single axis is
 * half-normal, two axes together are Rayleigh.
 */
const PERCENTILE = 0.2;
const HALF_NORMAL_Q20 = 0.2533;
const RAYLEIGH_Q20 = 0.668;

/**
 * Jitter below this is not jitter: clean fixtures and dead-still frames
 * measure zero on both sides, and zero over zero is not a ratio.
 */
const NOISE_FLOOR_M = 0.0005;

/** Fewer samples than this and a percentile is an anecdote. */
const MIN_SAMPLES = 10;

const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)];
};

/**
 * The largest depth doubt a joint may be given, as a variance ratio.
 *
 * Nine is depth three times as noisy as the picture. Past that, the solver
 * would push a joint along its line of sight by more than the bone error it
 * is fixing -- the sideways share of the fix still has to come from
 * somewhere -- and a clip that measures worse than this is not one whose
 * depth should be trusted to steer at all.
 */
export const MAX_DEPTH_DOUBT = 9;

/**
 * The most the hidden-by-body bid may take from a joint's trust.
 *
 * A hidden joint still carries evidence -- the detector found the limb, it
 * just could not see this end of it -- so it never falls to nothing.
 */
export const MIN_HIDDEN_TRUST = 0.25;

/* ------------------------------------------------------------------ *
 * What is in the way
 * ------------------------------------------------------------------ */

interface Occluder {
  readonly name: string;
  readonly from: ClarityJoint;
  readonly to: ClarityJoint;
  readonly radiusM: number;
}

/**
 * The golfer as the camera sees them, as capsules.
 *
 * The trunk is TWO capsules, one down each side, not one down the middle.
 * The case that matters most is the far hip down the line, and the thing in
 * front of it is the near side of the pelvis -- a single central capsule
 * puts its axis barely a hand's width in front of the far hip, and a joint
 * sitting on the surface of what hides it cannot be told from one sitting on
 * the surface of what it belongs to.
 *
 * A capsule never hides its own ends: an elbow is not behind its own
 * forearm. That is the only exclusion, and it is the one that makes the
 * sides work: the left side cannot hide the left hip, and can hide the
 * right.
 *
 * Radii at 1.8m, scaled with the golfer. Rough on purpose -- the question is
 * "was something in the way", and a thigh is a thigh.
 */
const OCCLUDERS: readonly Occluder[] = [
  { name: "left side of the trunk", from: "leftHip", to: "leftShoulder", radiusM: 0.1 },
  { name: "right side of the trunk", from: "rightHip", to: "rightShoulder", radiusM: 0.1 },
  { name: "head", from: "head", to: "neck", radiusM: 0.1 },
  { name: "left upper arm", from: "leftShoulder", to: "leftElbow", radiusM: 0.05 },
  { name: "right upper arm", from: "rightShoulder", to: "rightElbow", radiusM: 0.05 },
  { name: "left forearm", from: "leftElbow", to: "leftWrist", radiusM: 0.04 },
  { name: "right forearm", from: "rightElbow", to: "rightWrist", radiusM: 0.04 },
  { name: "left thigh", from: "leftHip", to: "leftKnee", radiusM: 0.08 },
  { name: "right thigh", from: "rightHip", to: "rightKnee", radiusM: 0.08 },
  { name: "left shin", from: "leftKnee", to: "leftAnkle", radiusM: 0.055 },
  { name: "right shin", from: "rightKnee", to: "rightAnkle", radiusM: 0.055 },
];

/**
 * Closest approach between two segments. Returns the parameter along each
 * (0..1) and the distance between the two closest points.
 */
const closestBetweenSegments = (
  p0: Vec3,
  p1: Vec3,
  q0: Vec3,
  q1: Vec3
): { s: number; t: number; distanceM: number } => {
  const d1 = sub(p1, p0);
  const d2 = sub(q1, q0);
  const r = sub(p0, q0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);

  let s = 0;
  let t = 0;
  if (a < 1e-12 && e < 1e-12) {
    // Both degenerate.
  } else if (a < 1e-12) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e < 1e-12) {
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  const onP: Vec3 = [p0[0] + d1[0] * s, p0[1] + d1[1] * s, p0[2] + d1[2] * s];
  const onQ: Vec3 = [q0[0] + d2[0] * t, q0[1] + d2[1] * t, q0[2] + d2[2] * t];
  return { s, t, distanceM: distance(onP, onQ) };
};

export interface Hiding {
  /** 0 = in plain view, 1 = squarely behind something. */
  readonly amount: Unit;
  readonly by: string | null;
}

const IN_VIEW: Hiding = { amount: 0, by: null };

/**
 * How far behind another part of the body one joint was, from the camera.
 *
 * Two things have to be true. The line of sight has to pass INSIDE a
 * capsule -- how deep inside is the first half of the amount. And the place
 * it passes through has to be IN FRONT of the joint, by more than half the
 * capsule's radius: a joint on the near surface of its own trunk has the
 * trunk's axis right beside it, not in front of it, and is in plain view.
 */
export const hiddenBehind = (
  joint: ClarityJoint,
  joints: Readonly<Record<ClarityJoint, Vec3>>,
  camera: Vec3,
  heightM: number
): Hiding => {
  const target = joints[joint];
  const sightM = distance(camera, target);
  if (sightM < 1e-6) return IN_VIEW;
  const bodyScale = heightM / 1.8;

  let best = IN_VIEW;
  for (const occluder of OCCLUDERS) {
    if (occluder.from === joint || occluder.to === joint) continue;
    const radiusM = occluder.radiusM * bodyScale;
    const { s, distanceM } = closestBetweenSegments(
      camera,
      target,
      joints[occluder.from],
      joints[occluder.to]
    );
    const inside = clampUnit((radiusM - distanceM) / radiusM);
    if (inside === 0) continue;
    const inFrontM = (1 - s) * sightM;
    const ahead = clampUnit((inFrontM - radiusM * 0.5) / radiusM);
    const amount = inside * ahead;
    if (amount > best.amount) best = { amount, by: occluder.name };
  }
  return best;
};

/* ------------------------------------------------------------------ *
 * The bids
 * ------------------------------------------------------------------ */

export interface ContextBidInput {
  /** The Motion Layer's current belief about every joint, per frame. */
  readonly positions: (frame: number) => Readonly<Record<ClarityJoint, Vec3>>;
  /** Observations, for measuring jitter. Only real samples are measured. */
  readonly tracks: Tracks;
  readonly cameras: readonly (Vec3 | null)[];
  readonly heightM: number;
  readonly frameCount: number;
}

export interface ContextBidReport {
  /** How many frames had a camera to reason from. */
  readonly framesWithCamera: number;
  /**
   * Per joint: depth jitter over picture jitter, as a variance ratio. 1 when
   * depth was no worse, or when there was too little to measure.
   */
  readonly depthDoubt: Readonly<Record<ClarityJoint, number>>;
  /**
   * Hidden jitter over visible jitter, as a variance ratio, pooled over the
   * clip. Null when too few hidden samples were seen to measure it.
   */
  readonly hiddenNoiseRatio: number | null;
  /** Per joint, per frame. */
  readonly hiding: Readonly<Record<ClarityJoint, readonly Hiding[]>>;
  /** Per joint, per frame: the trust multiplier the hidden bid applies. */
  readonly hiddenTrust: Readonly<Record<ClarityJoint, readonly Unit[]>>;
  /** Per frame, the camera centre the bids used. */
  readonly cameras: readonly (Vec3 | null)[];
}

/** Samples at least this hidden count as hidden when measuring jitter. */
const HIDDEN_FOR_MEASURING = 0.5;

export const computeContextBids = (input: ContextBidInput): ContextBidReport => {
  const { tracks, cameras, heightM, frameCount } = input;
  const framesWithCamera = cameras.filter((camera) => camera !== null).length;

  // Who was hidden, on the body as reconstructed so far.
  const hiding = {} as Record<ClarityJoint, Hiding[]>;
  for (const joint of CLARITY_JOINTS) hiding[joint] = new Array(frameCount).fill(IN_VIEW);
  for (let index = 0; index < frameCount; index += 1) {
    const camera = cameras[index];
    if (!camera) continue;
    const joints = input.positions(index);
    for (const joint of CLARITY_JOINTS) {
      hiding[joint][index] = hiddenBehind(joint, joints, camera, heightM);
    }
  }

  /*
   * Jitter, measured on the OBSERVATIONS -- nothing the Motion Layer has
   * produced can say how good the detector was. A sample counts only when it
   * and both its neighbours were seen.
   */
  const depthDoubt = {} as Record<ClarityJoint, number>;
  const alongAll: number[] = [];
  const acrossAll: number[] = [];
  const visible: number[] = [];
  const hidden: number[] = [];

  for (const joint of CLARITY_JOINTS) {
    const samples = tracks[joint].samples;
    const along: number[] = [];
    const across: number[] = [];
    const deviation: { magnitude: number; hidden: boolean }[] = [];

    for (let index = 1; index < samples.length - 1; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      const next = samples[index + 1];
      const camera = cameras[index];
      if (!previous || !current || !next || !camera) continue;

      const second: Vec3 = sub(current.position, scale(
        [
          previous.position[0] + next.position[0],
          previous.position[1] + next.position[1],
          previous.position[2] + next.position[2],
        ],
        0.5
      ));
      const ray = normalise(sub(current.position, camera));
      const alongM = dot(second, ray);
      const acrossM = Math.hypot(
        second[0] - ray[0] * alongM,
        second[1] - ray[1] * alongM,
        second[2] - ray[2] * alongM
      );
      along.push(Math.abs(alongM));
      across.push(acrossM);
      deviation.push({
        magnitude: acrossM,
        hidden: hiding[joint][index].amount >= HIDDEN_FOR_MEASURING,
      });
    }

    alongAll.push(...along);
    acrossAll.push(...across);
    depthDoubt[joint] = along.length >= MIN_SAMPLES ? doubtFrom(along, across) : Number.NaN;

    /*
     * Hidden against visible, normalised by this joint's own visible jitter,
     * so a naturally jittery wrist pooled with a steady hip compares each
     * with itself.
     *
     * ACROSS THE PICTURE ONLY. Depth jitter is the other bid's business, and
     * letting it in here counted it twice: on a clip whose only fault was
     * depth noise, hidden samples measured half as noisy again as visible
     * ones -- a hidden joint is usually a far one, and a far joint's depth
     * error lands differently -- and the hidden bid took a third of their
     * trust for a fault the depth bid had already priced. A detector that
     * cannot see a joint is guessing where it is in the picture too, so the
     * picture is where being hidden shows.
     */
    const seen = deviation.filter((entry) => !entry.hidden).map((entry) => entry.magnitude);
    if (seen.length < MIN_SAMPLES) continue;
    // Floored on both sides, so a clean clip compares floor with floor and
    // measures a ratio of one rather than dividing one rounding error by
    // another.
    const reference = Math.max(NOISE_FLOOR_M, quantile(seen, PERCENTILE));
    for (const entry of deviation) {
      (entry.hidden ? hidden : visible).push(Math.max(NOISE_FLOOR_M, entry.magnitude) / reference);
    }
  }

  // A joint with too few samples of its own borrows the clip's.
  const pooled = alongAll.length >= MIN_SAMPLES ? doubtFrom(alongAll, acrossAll) : 1;
  for (const joint of CLARITY_JOINTS) {
    if (Number.isNaN(depthDoubt[joint])) depthDoubt[joint] = pooled;
  }

  const hiddenNoiseRatio =
    hidden.length >= MIN_SAMPLES && visible.length >= MIN_SAMPLES
      ? (quantile(hidden, PERCENTILE) / Math.max(1e-9, quantile(visible, PERCENTILE))) ** 2
      : null;
  // What a squarely hidden sample keeps: the inverse of how much noisier
  // hidden samples measured. Never more than it had, never under the floor.
  const fullyHiddenTrust =
    hiddenNoiseRatio === null ? 1 : clamp(1 / hiddenNoiseRatio, MIN_HIDDEN_TRUST, 1);

  const hiddenTrust = {} as Record<ClarityJoint, Unit[]>;
  for (const joint of CLARITY_JOINTS) {
    hiddenTrust[joint] = hiding[joint].map((entry) =>
      clampUnit(1 - entry.amount * (1 - fullyHiddenTrust))
    );
  }

  return { framesWithCamera, depthDoubt, hiddenNoiseRatio, hiding, hiddenTrust, cameras };
};

/** Depth variance over per-axis picture variance, clamped to what the solver may use. */
const doubtFrom = (along: number[], across: number[]): number => {
  const depthSigma = Math.max(NOISE_FLOOR_M, quantile(along, PERCENTILE) / HALF_NORMAL_Q20);
  const pictureSigma = Math.max(NOISE_FLOOR_M, quantile(across, PERCENTILE) / RAYLEIGH_Q20);
  return clamp((depthSigma / pictureSigma) ** 2, 1, MAX_DEPTH_DOUBT);
};
