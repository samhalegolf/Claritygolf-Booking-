/**
 * One swing, filmed from two places at once: face-on and down the line.
 *
 * WHY TWO CAMERAS ARE WORTH MORE THAN TWICE ONE
 *
 * A single camera places a point well across the picture and badly along its
 * own line of sight -- measured on real clips, the detector's depth axis comes
 * back compressed by about half, and the far arm spends the backswing hidden
 * behind the body. The README's own table says the two views are exact
 * complements: face-on the stance lies across the picture and measures right;
 * down the line it lies along depth and halves.
 *
 * Put a second camera roughly square to the first and each one's blind axis
 * is the other's clearest. Nothing here assumes the second camera is exactly
 * square, or exactly anywhere: the angle between them is measured from the
 * golfer, so a down-the-line phone set a little off the target line works the
 * same way, only with less to gain the closer the two cameras get.
 *
 * WHAT THIS DOES, IN ORDER
 *
 *   1. SYNC.    Two phones never start recording on the same frame. The
 *               clips are lined up by the height of the hands, which is the
 *               same curve whichever side it is filmed from -- low at
 *               address, high at the top, low at impact, high at the finish.
 *   2. ALIGN.   Both clips are hip-centred, Y-up and metric, so all that is
 *               unknown between them is one rotation (the angle between the
 *               cameras), one small scale (the two readings of body size),
 *               and how badly each camera compressed its own depth. Solved
 *               together, over every joint both saw.
 *   3. FUSE.    Every joint is placed where both cameras agree best, each
 *               trusted across its picture and hardly at all along its line
 *               of sight. A joint only one camera saw is taken from that
 *               camera.
 *
 * WHAT COMES OUT
 *
 * A CameraObservationSequence on the PRIMARY clip's timeline and in the
 * primary camera's axes, with its pixels untouched -- so the video overlay,
 * the clubhead search and the club's camera fit all keep working on the clip
 * that is on screen. Only the 3D lift has changed, and the whole Motion Layer
 * runs on it exactly as it runs on one clip.
 *
 * WHAT IT DOES NOT DO
 *
 * The club comes from the primary clip alone. Its known limit -- depth wrong
 * by hundreds of millimetres when the camera is square to the swing -- is
 * exactly what a second view would fix, by triangulating the clubhead, and it
 * is left for its own change rather than folded into this one.
 */

import type { ClarityJoint, Quat, Vec3 } from "../../contracts";
import {
  OBSERVABLE_JOINTS,
  add,
  dot,
  fitRigidTransform,
  lerpVec,
  qConjugate,
  qIdentity,
  qRotate,
  scale,
  sub,
  type Correspondence,
} from "../../contracts";
import type {
  CameraObservationFrame,
  CameraObservationSequence,
  ObservedJoint,
} from "../../observe/observation";

export interface TwoViewReport {
  /** False when the clips could not be put together; the primary is then used alone. */
  readonly usable: boolean;
  /** Why not, in words. Null when usable. */
  readonly reason: string | null;
  /**
   * Where the second clip's clock sits against the first's, milliseconds:
   * the second clip's time is `primary time × rate + offsetMs`.
   */
  readonly offsetMs: number;
  /**
   * How fast the second clip's clock runs against the first's. 1 for two
   * ordinary recordings; not 1 when one of them is a slow-motion export.
   */
  readonly rate: number;
  /** How well the hand-height curves matched once lined up, 0..1. */
  readonly syncScore: number;
  /** Angle between the two cameras' lines of sight, degrees. */
  readonly angleBetweenDeg: number;
  /**
   * How much each camera compressed its own depth: 1 is true depth, 0.5 is
   * half. Measured from the other camera, so only when they are far enough
   * apart for one to see across the other's depth; 1 otherwise.
   */
  readonly depthScale: { readonly primary: number; readonly second: number };
  /** Whether `depthScale` was measured, or left at 1 because the cameras were too close. */
  readonly depthMeasured: boolean;
  /** Second clip's body size over the first's. Near 1; far from it means a different golfer. */
  readonly sizeRatio: number;
  /** Primary frames the second clip had evidence for. */
  readonly sharedFrames: number;
  /** Joint readings only the second camera had, added to the primary's. */
  readonly addedFromSecond: number;
  /** Joints the two cameras put more than `CONFLICT_M` apart, where one had to be chosen. */
  readonly conflicts: number;
  /** Median distance between where the two cameras put the same joint once aligned, metres. */
  readonly agreementM: number;
}

export interface TwoViewFusion {
  /** The fused clip. The primary itself, untouched, when `report.usable` is false. */
  readonly sequence: CameraObservationSequence;
  readonly report: TwoViewReport;
}

/**
 * How much a camera is trusted along its own line of sight, against across
 * its picture, as a precision ratio. Small on purpose: along its line of
 * sight a detector is guessing, and the other camera is not.
 */
const DEPTH_WEIGHT = 0.1;

/**
 * Below this angle the cameras see nearly the same thing, so neither can
 * measure the other's depth and `depthScale` is left at 1.
 */
const MIN_DEPTH_ANGLE_DEG = 30;

/** Below this the hand-height curves did not match, and the clips are not the same swing. */
const MIN_SYNC_SCORE = 0.6;

/**
 * Beyond this TYPICAL disagreement, once aligned, the two clips are not one
 * swing. The sync alone cannot say so: a different swing by the same golfer
 * has much the same hand-height curve, and lines up in time happily. Where
 * the body is at each of those moments is what gives it away.
 */
const MAX_AGREEMENT_M = 0.15;

/** Beyond this the cameras disagree about a joint too much to average it. */
const CONFLICT_M = 0.25;

/**
 * Clock rates tried, for a slow-motion export against a normal clip. 1 wins
 * unless another matches clearly better, because a spurious rate would shear
 * the whole swing in time.
 */
const RATES = [1, 2, 0.5, 4, 0.25, 8, 0.125] as const;
const RATE_PREFERENCE = 0.05;

const HAND_JOINTS: readonly ClarityJoint[] = ["leftWrist", "rightWrist", "leftHand", "rightHand"];

/* ------------------------------ sync ------------------------------- */

interface Sample {
  readonly t: number;
  readonly v: number;
}

/**
 * The height of the hands above the hips, per frame.
 *
 * Chosen because it is the same curve from any side: camera space is Y-up and
 * hip-centred for both clips, and turning about the vertical cannot move a
 * height. A speed or a sideways position would change with the viewpoint.
 */
const handHeight = (sequence: CameraObservationSequence): Sample[] => {
  const samples: Sample[] = [];
  for (const frame of sequence.frames) {
    let sum = 0;
    let count = 0;
    for (const joint of HAND_JOINTS) {
      const observed = frame.joints[joint];
      if (!observed) continue;
      sum += observed.position[1];
      count += 1;
    }
    if (count > 0) samples.push({ t: frame.timestampMs, v: sum / count });
  }
  return samples;
};

const medianInterval = (samples: readonly { t: number }[]): number => {
  if (samples.length < 2) return 1000 / 30;
  const gaps: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    gaps.push(samples[index].t - samples[index - 1].t);
  }
  gaps.sort((a, b) => a - b);
  return Math.max(1e-3, gaps[Math.floor(gaps.length / 2)]);
};

/** First index whose time is >= t. */
const lowerBound = (samples: readonly { t: number }[], t: number): number => {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (samples[middle].t < t) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** Linear interpolation, refusing to bridge a gap longer than `maxGapMs`. */
const sampleAt = (samples: readonly Sample[], t: number, maxGapMs: number): number | null => {
  const after = lowerBound(samples, t);
  if (after < samples.length && samples[after].t === t) return samples[after].v;
  if (after === 0 || after >= samples.length) return null;
  const a = samples[after - 1];
  const b = samples[after];
  if (b.t - a.t > maxGapMs) return null;
  const f = (t - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * f;
};

interface SyncResult {
  readonly rate: number;
  readonly offsetMs: number;
  readonly score: number;
}

/**
 * Line the two hand-height curves up.
 *
 * Normalised cross-correlation over every offset at which they overlap, one
 * second-clip frame apart, then refined to a tenth of that around the best.
 * The score is discounted when the overlap is short: two short monotonic
 * stretches correlate perfectly and prove nothing, so a match has to cover
 * most of the shorter clip to count.
 */
export const syncByHandHeight = (
  primary: CameraObservationSequence,
  second: CameraObservationSequence
): SyncResult => {
  const a = handHeight(primary);
  const b = handHeight(second);
  if (a.length < 8 || b.length < 8) return { rate: 1, offsetMs: 0, score: 0 };

  const stepB = medianInterval(b);
  const maxGap = stepB * 3.5;
  const shorter = Math.min(a.length, b.length);

  const scoreAt = (rate: number, offset: number): number => {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    let first = Infinity;
    let last = -Infinity;
    for (const sample of a) {
      const u = sample.t * rate + offset;
      const other = sampleAt(b, u, maxGap);
      if (other === null) continue;
      first = Math.min(first, u);
      last = Math.max(last, u);
      n += 1;
      sa += sample.v;
      sb += other;
      saa += sample.v * sample.v;
      sbb += other * other;
      sab += sample.v * other;
    }
    if (n < 8) return 0;
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    if (va <= 1e-12 || vb <= 1e-12) return 0;
    const ncc = (sab - (sa * sb) / n) / Math.sqrt(va * vb);
    /*
     * Overlap is judged on BOTH clocks. Counting only the primary's samples
     * let a clip squeezed into a quarter of the other -- a wrong slow-motion
     * rate -- claim full coverage while matching a sliver of it.
     */
    const secondCovered = (last - first) / stepB + 1;
    const coverage = Math.min(1, Math.min(n, secondCovered) / (0.6 * shorter));
    return ncc * coverage;
  };

  let best: SyncResult = { rate: 1, offsetMs: 0, score: 0 };
  let bestAtOne: SyncResult = best;

  for (const rate of RATES) {
    const lowest = b[0].t - rate * a[a.length - 1].t;
    const highest = b[b.length - 1].t - rate * a[0].t;
    let local: SyncResult = { rate, offsetMs: 0, score: -Infinity };
    for (let offset = lowest; offset <= highest; offset += stepB) {
      const score = scoreAt(rate, offset);
      if (score > local.score) local = { rate, offsetMs: offset, score };
    }
    // Refine between the neighbouring coarse steps.
    const fine = stepB / 10;
    for (let offset = local.offsetMs - stepB; offset <= local.offsetMs + stepB; offset += fine) {
      const score = scoreAt(rate, offset);
      if (score > local.score) local = { rate, offsetMs: offset, score };
    }
    if (rate === 1) bestAtOne = local;
    if (local.score > best.score) best = local;
  }

  return best.rate !== 1 && best.score < bestAtOne.score + RATE_PREFERENCE ? bestAtOne : best;
};

/* ---------------------------- resampling ---------------------------- */

/**
 * The second clip's joints at one moment of its own clock.
 *
 * Interpolated between the frames either side when both saw the joint and
 * they are close together; otherwise taken from a frame that is almost
 * exactly on time; otherwise not at all. A joint neither neighbour saw is
 * absent, the same as in any single clip.
 */
const secondAt = (
  frames: readonly CameraObservationFrame[],
  times: readonly { t: number }[],
  t: number,
  step: number
): Partial<Record<ClarityJoint, ObservedJoint>> => {
  const out: Partial<Record<ClarityJoint, ObservedJoint>> = {};
  const after = lowerBound(times, t);
  const before = after - 1;
  const a = before >= 0 ? frames[before] : null;
  const b = after < frames.length ? frames[after] : null;

  for (const joint of OBSERVABLE_JOINTS) {
    const ja = a?.joints[joint];
    const jb = b?.joints[joint];
    if (a && b && ja && jb && b.timestampMs - a.timestampMs <= step * 2.5) {
      const span = b.timestampMs - a.timestampMs;
      const f = span > 0 ? (t - a.timestampMs) / span : 0;
      out[joint] = {
        ...ja,
        position: lerpVec(ja.position as Vec3, jb.position as Vec3, f) as [number, number, number],
        visibility: Math.min(ja.visibility, jb.visibility),
      };
      continue;
    }
    if (a && ja && t - a.timestampMs <= step * 0.25) out[joint] = ja;
    else if (b && jb && b.timestampMs - t <= step * 0.25) out[joint] = jb;
  }
  return out;
};

/* --------------------------- small algebra --------------------------- */

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** R diag(1, 1, w) Rᵀ, where R is the rotation `q`. The second camera's precision in primary axes. */
const precisionOf = (q: Quat, depthWeight: number): Mat3 => {
  const x = qRotate(q, [1, 0, 0]);
  const y = qRotate(q, [0, 1, 0]);
  const z = qRotate(q, [0, 0, 1]);
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      m[row * 3 + column] = x[row] * x[column] + y[row] * y[column] + depthWeight * z[row] * z[column];
    }
  }
  return m as unknown as Mat3;
};

const mulVec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const invert = (m: Mat3): Mat3 => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
};

const withDepth = (point: Vec3, depthScale: number): Vec3 => [point[0], point[1], point[2] / depthScale];

/* ------------------------------ fusion ------------------------------ */

interface Pair {
  /** Primary camera, as the detector lifted it. */
  readonly p: Vec3;
  /** Second camera, as the detector lifted it, resampled onto the primary's clock. */
  readonly s: Vec3;
  readonly weight: number;
}

interface Alignment {
  /** Second camera's axes into the primary's. */
  readonly rotation: Quat;
  readonly translation: Vec3;
  readonly size: number;
  readonly depthPrimary: number;
  readonly depthSecond: number;
  readonly depthMeasured: boolean;
}

const angleBetweenDeg = (rotation: Quat): number => {
  const axis = qRotate(rotation, [0, 0, 1]);
  return (Math.acos(Math.max(-1, Math.min(1, axis[2]))) * 180) / Math.PI;
};

/** A second-camera reading, carried into the primary's axes with its depth undone. */
const secondToPrimary = (alignment: Alignment, s: Vec3): Vec3 =>
  add(scale(qRotate(alignment.rotation, withDepth(s, alignment.depthSecond)), alignment.size), alignment.translation);

/**
 * Where both readings of one joint agree best: each camera trusted across its
 * picture and hardly along its line of sight. The weighted least-squares
 * point, in closed form, since both precisions are the same for every joint.
 */
const fuser = (alignment: Alignment) => {
  const primaryPrecision = precisionOf(qIdentity(), DEPTH_WEIGHT);
  const secondPrecision = precisionOf(alignment.rotation, DEPTH_WEIGHT);
  const total = invert(
    primaryPrecision.map((value, index) => value + secondPrecision[index]) as unknown as Mat3
  );
  return (p: Vec3, s: Vec3) => {
    const P = withDepth(p, alignment.depthPrimary);
    const Q = secondToPrimary(alignment, s);
    return {
      fused: mulVec(total, add(mulVec(primaryPrecision, P), mulVec(secondPrecision, Q))),
      primary: P,
      second: Q,
    };
  };
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * The rotation, scale and depth compression that bring the two cameras into
 * one body, solved by alternation.
 *
 * Each step is a problem with a closed form -- a rigid fit, a scale along the
 * one axis both cameras see across (up), a depth factor per camera against
 * the fused body -- and each is fed the others' latest answer. A handful of
 * rounds settles it; the depth factors are the slow ones.
 *
 * The depth factors are only measurable when one camera sees across the
 * other's depth. Close together, both would be fitted to their own echo, so
 * below `MIN_DEPTH_ANGLE_DEG` they stay at 1 and the report says so.
 */
const align = (pairs: readonly Pair[]): Alignment => {
  let alignment: Alignment = {
    rotation: qIdentity(),
    translation: [0, 0, 0],
    size: 1,
    depthPrimary: 1,
    depthSecond: 1,
    depthMeasured: false,
  };
  let weights = pairs.map((pair) => pair.weight);

  for (let round = 0; round < 12; round += 1) {
    const correspondences: Correspondence[] = pairs.map((pair, index) => ({
      from: scale(withDepth(pair.s, alignment.depthSecond), alignment.size),
      to: withDepth(pair.p, alignment.depthPrimary),
      weight: weights[index],
    }));
    const fit = fitRigidTransform(correspondences, alignment.rotation);
    if (!fit) break;
    alignment = { ...alignment, rotation: fit.rotation, translation: fit.translation };

    // Size from the vertical, which both cameras see across their picture.
    let num = 0;
    let den = 0;
    pairs.forEach((pair, index) => {
      const q = qRotate(alignment.rotation, withDepth(pair.s, alignment.depthSecond));
      num += weights[index] * q[1] * withDepth(pair.p, alignment.depthPrimary)[1];
      den += weights[index] * q[1] * q[1];
    });
    if (den > 1e-9) alignment = { ...alignment, size: Math.max(0.7, Math.min(1.4, num / den)) };

    const fuse = fuser(alignment);
    const results = pairs.map((pair) => fuse(pair.p, pair.s));

    if (angleBetweenDeg(alignment.rotation) >= MIN_DEPTH_ANGLE_DEG) {
      // Each camera's raw depth against the fused body's depth in that camera's axes.
      let pNum = 0;
      let pDen = 0;
      let sNum = 0;
      let sDen = 0;
      const inverse = qConjugate(alignment.rotation);
      pairs.forEach((pair, index) => {
        const w = weights[index];
        const fused = results[index].fused;
        pNum += w * pair.p[2] * fused[2];
        pDen += w * fused[2] * fused[2];
        const inSecond = scale(qRotate(inverse, sub(fused, alignment.translation)), 1 / alignment.size);
        sNum += w * pair.s[2] * inSecond[2];
        sDen += w * inSecond[2] * inSecond[2];
      });
      alignment = {
        ...alignment,
        depthPrimary: pDen > 1e-9 ? Math.max(0.25, Math.min(1.5, pNum / pDen)) : alignment.depthPrimary,
        depthSecond: sDen > 1e-9 ? Math.max(0.25, Math.min(1.5, sNum / sDen)) : alignment.depthSecond,
        depthMeasured: true,
      };
    }

    /*
     * Past the first rounds, a pair the two cameras flatly disagree about --
     * a detector that swapped sides on one frame, a hand lost into the body --
     * stops pulling on the fit. Judged against the typical disagreement, not
     * a fixed distance, so a noisy pair of clips is not emptied out.
     */
    if (round >= 2) {
      const gaps = results.map((result) => {
        const d = sub(result.primary, result.second);
        return Math.hypot(d[0], d[1], d[2]);
      });
      const typical = Math.max(0.02, median(gaps));
      weights = pairs.map((pair, index) => (gaps[index] > typical * 3 ? 0 : pair.weight));
    }
  }

  return alignment;
};

/**
 * Where a joint only the second camera saw lands in the primary's picture.
 *
 * `ObservedJoint` carries a pixel, and for this joint the primary has none.
 * It is projected with a linear camera fitted over the joints both cameras
 * saw, anchored per frame at the primary's own hip pixel. The joint is marked
 * `views: "second"` so nothing mistakes that pixel for an observation -- the
 * club's camera fit, which pairs pixels with positions, skips it.
 */
const fitImageProjection = (
  frames: readonly CameraObservationFrame[],
  positionsOf: (frameIndex: number, joint: ClarityJoint) => Vec3 | null
) => {
  // Two regressions, image x and image y, on the 3D offset from the hips.
  const ata = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const atx = [0, 0, 0];
  const aty = [0, 0, 0];
  let samples = 0;

  const hipOf = (frame: CameraObservationFrame, frameIndex: number) => {
    const left = frame.joints.leftHip;
    const right = frame.joints.rightHip;
    const leftAt = positionsOf(frameIndex, "leftHip");
    const rightAt = positionsOf(frameIndex, "rightHip");
    if (!left || !right || !leftAt || !rightAt) return null;
    return {
      image: [(left.image[0] + right.image[0]) / 2, (left.image[1] + right.image[1]) / 2] as const,
      position: lerpVec(leftAt, rightAt, 0.5),
    };
  };

  frames.forEach((frame, frameIndex) => {
    const hip = hipOf(frame, frameIndex);
    if (!hip) return;
    for (const joint of OBSERVABLE_JOINTS) {
      const observed = frame.joints[joint];
      const position = positionsOf(frameIndex, joint);
      if (!observed || !position) continue;
      const d = sub(position, hip.position);
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) ata[row * 3 + column] += d[row] * d[column];
        atx[row] += d[row] * (observed.image[0] - hip.image[0]);
        aty[row] += d[row] * (observed.image[1] - hip.image[1]);
      }
      samples += 1;
    }
  });

  if (samples < 12) return null;
  const inverse = invert(ata as unknown as Mat3);
  if (!inverse.every(Number.isFinite)) return null;
  const rowX = mulVec(inverse, atx as unknown as Vec3);
  const rowY = mulVec(inverse, aty as unknown as Vec3);

  return (frame: CameraObservationFrame, frameIndex: number, position: Vec3): [number, number] | null => {
    const hip = hipOf(frame, frameIndex);
    if (!hip) return null;
    const d = sub(position, hip.position);
    return [hip.image[0] + dot(rowX, d), hip.image[1] + dot(rowY, d)];
  };
};

const unusable = (
  primary: CameraObservationSequence,
  reason: string,
  partial: Partial<TwoViewReport> = {}
): TwoViewFusion => ({
  sequence: primary,
  report: {
    usable: false,
    reason,
    offsetMs: 0,
    rate: 1,
    syncScore: 0,
    angleBetweenDeg: 0,
    depthScale: { primary: 1, second: 1 },
    depthMeasured: false,
    sizeRatio: 1,
    sharedFrames: 0,
    addedFromSecond: 0,
    conflicts: 0,
    agreementM: 0,
    ...partial,
  },
});

export const fuseTwoViews = (
  primary: CameraObservationSequence,
  second: CameraObservationSequence
): TwoViewFusion => {
  const sync = syncByHandHeight(primary, second);
  if (sync.score < MIN_SYNC_SCORE) {
    return unusable(
      primary,
      "the two clips could not be lined up in time from the hands -- check they are the same swing",
      { syncScore: Math.max(0, sync.score), offsetMs: sync.offsetMs, rate: sync.rate }
    );
  }

  const times = second.frames.map((frame) => ({ t: frame.timestampMs }));
  const step = medianInterval(times);
  const resampled = primary.frames.map((frame) =>
    secondAt(second.frames, times, frame.timestampMs * sync.rate + sync.offsetMs, step)
  );

  const pairs: Pair[] = [];
  primary.frames.forEach((frame, index) => {
    for (const joint of OBSERVABLE_JOINTS) {
      const p = frame.joints[joint];
      const s = resampled[index][joint];
      if (!p || !s) continue;
      pairs.push({
        p: p.position as Vec3,
        s: s.position as Vec3,
        weight: Math.min(p.visibility, s.visibility),
      });
    }
  });

  const sharedFrames = resampled.filter((joints) => Object.keys(joints).length > 0).length;
  if (pairs.length < 60) {
    return unusable(primary, "the two clips share too few moments where both saw the golfer", {
      syncScore: sync.score,
      offsetMs: sync.offsetMs,
      rate: sync.rate,
      sharedFrames,
    });
  }

  const alignment = align(pairs);
  const fuse = fuser(alignment);

  /*
   * Every joint of every primary frame, placed. Held per frame so the image
   * projection for second-only joints can be fitted over the result.
   */
  const placed: Partial<Record<ClarityJoint, { position: Vec3; views: ObservedJoint["views"]; visibility: number }>>[] = [];
  const gaps: number[] = [];
  let conflicts = 0;

  primary.frames.forEach((frame, index) => {
    const out: (typeof placed)[number] = {};
    for (const joint of OBSERVABLE_JOINTS) {
      const p = frame.joints[joint];
      const s = resampled[index][joint];
      if (p && s) {
        const result = fuse(p.position as Vec3, s.position as Vec3);
        const d = sub(result.primary, result.second);
        const gap = Math.hypot(d[0], d[1], d[2]);
        gaps.push(gap);
        if (gap > CONFLICT_M) {
          /*
           * Too far apart to average: the midpoint of two readings half a
           * metre apart is a place neither camera put the joint. The more
           * confident camera is taken, and the count says it happened.
           */
          conflicts += 1;
          const primaryWins = p.visibility >= s.visibility;
          out[joint] = {
            position: primaryWins ? result.primary : result.second,
            views: primaryWins ? "primary" : "second",
            visibility: primaryWins ? p.visibility : s.visibility,
          };
        } else {
          out[joint] = {
            position: result.fused,
            views: "both",
            visibility: Math.max(p.visibility, s.visibility),
          };
        }
      } else if (p) {
        out[joint] = {
          position: withDepth(p.position as Vec3, alignment.depthPrimary),
          views: "primary",
          visibility: p.visibility,
        };
      } else if (s) {
        out[joint] = {
          position: secondToPrimary(alignment, s.position as Vec3),
          views: "second",
          visibility: s.visibility,
        };
      }
    }
    placed.push(out);
  });

  const agreementM = median(gaps);
  if (agreementM > MAX_AGREEMENT_M) {
    return unusable(
      primary,
      `once lined up, the two cameras put the same joints ${(agreementM * 100).toFixed(0)} cm apart -- they do not look like the same swing`,
      {
        syncScore: sync.score,
        offsetMs: sync.offsetMs,
        rate: sync.rate,
        angleBetweenDeg: angleBetweenDeg(alignment.rotation),
        sharedFrames,
        agreementM,
      }
    );
  }

  const project = fitImageProjection(
    primary.frames,
    (frameIndex, joint) => placed[frameIndex][joint]?.position ?? null
  );

  let addedFromSecond = 0;
  const frames: CameraObservationFrame[] = primary.frames.map((frame, index) => {
    const joints: Partial<Record<ClarityJoint, ObservedJoint>> = {};
    for (const [joint, entry] of Object.entries(placed[index]) as [
      ClarityJoint,
      NonNullable<(typeof placed)[number][ClarityJoint]>,
    ][]) {
      const own = frame.joints[joint];
      const image = own ? own.image : project?.(frame, index, entry.position) ?? null;
      // A second-only joint with no way to place it in the picture is left out.
      if (!image) continue;
      if (!own) addedFromSecond += 1;
      joints[joint] = {
        position: entry.position as unknown as [number, number, number],
        image: image as [number, number],
        visibility: entry.visibility,
        sourceCount: own?.sourceCount ?? resampled[index][joint]?.sourceCount ?? 1,
        views: own ? entry.views : "second",
      };
    }
    return {
      ...frame,
      // A frame the primary missed but the second camera caught is now seen.
      detected: frame.detected || Object.keys(joints).length > 0,
      joints,
    };
  });

  return {
    sequence: {
      ...primary,
      frames,
      detector: `${primary.detector} + second angle`,
    },
    report: {
      usable: true,
      reason: null,
      offsetMs: sync.offsetMs,
      rate: sync.rate,
      syncScore: sync.score,
      angleBetweenDeg: angleBetweenDeg(alignment.rotation),
      depthScale: { primary: alignment.depthPrimary, second: alignment.depthSecond },
      depthMeasured: alignment.depthMeasured,
      sizeRatio: alignment.size,
      sharedFrames,
      addedFromSecond,
      conflicts,
      agreementM,
    },
  };
};
