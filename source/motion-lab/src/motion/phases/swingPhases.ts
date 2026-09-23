/**
 * Where the swing's positions are in time.
 *
 * Six moments -- setup, takeaway, top, delivery, impact, finish -- found from
 * the path of the hands in the detector's own image space. Image space on
 * purpose: these are TIMES, not positions, and the one thing a time needs is
 * a signal that moves when the swing moves. The hands in the picture do that
 * from any camera angle, and they need no reconstruction to trust.
 *
 * This is golf knowledge used to FIND, which the build plan allows: it says
 * "the top is where the hands stop rising before the fastest move in the
 * clip", and nothing downstream is told how the body must have moved there.
 * Each phase carries its own confidence and any of them can be missing; a
 * phase that cannot be found is reported as not found rather than placed at
 * a guessed fraction of the clip.
 *
 * WHAT EACH ONE IS, AS MEASURED
 *
 *   top       the highest hands before the fastest hand speed in the clip,
 *             at the END of any pause there -- the moment the downswing
 *             leaves, not the moment the backswing arrives
 *   setup     the last still frame at address, found by walking back from
 *             the top past that pause and then the backswing
 *   takeaway  a quarter of the hands' path from setup to the top
 *   impact    the bottom of the first dip in hand height after the top
 *   delivery  three quarters of the hands' path from the top to impact
 *   finish    the first still frame after impact, else the highest hands
 *
 * "Still" is measured in torso lengths per second, so it holds whether the
 * player fills the frame or stands small in it.
 *
 * Nothing here is a fixed swing duration. Phone clips are often slow motion
 * re-timed to 30fps, where a downswing lasts a full second of clip time, so
 * every search is bounded by the shape of the hand path rather than by a
 * window of milliseconds. (The one time window, before the peak, is only a
 * cap on how far back to look for the top.) The fastest hand move is not
 * impact either: the release after impact is often faster than anything
 * before it.
 */

import type { ObservationFrame } from "../../observe/observation";

export type SwingPhaseKey = "setup" | "takeaway" | "top" | "delivery" | "impact" | "finish";

export const SWING_PHASE_ORDER: readonly SwingPhaseKey[] = [
  "setup",
  "takeaway",
  "top",
  "delivery",
  "impact",
  "finish",
];

export interface SwingPhase {
  /** Clip time, the same clock as ObservationFrame.timestampMs. */
  readonly timeMs: number;
  /** 0..1. How much hand evidence there was around this moment. */
  readonly confidence: number;
}

export interface SwingPhases {
  readonly phases: Readonly<Partial<Record<SwingPhaseKey, SwingPhase>>>;
  /** Set when no swing could be found at all. */
  readonly failure: string | null;
}

/** Detector indices. Kept local so this file reads observe/ types only. */
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const LEFT_HIP = 23;
const RIGHT_HIP = 24;

/**
 * Below this a wrist is treated as unseen for that frame. Low on purpose:
 * hands blur in the downswing and MediaPipe's visibility sags to 0.2-0.3
 * there on real phone clips while the positions it gives stay consistent.
 */
const MIN_VISIBILITY = 0.2;
/** Hands slower than this, in torso lengths a second, count as still. */
const STILL_SPEED = 0.35;
/** A swing's hands peak far above this; a waggle does not get near it. */
const MIN_SWING_SPEED = 2.5;
/** How far before the fastest move to look for the top. Slow motion is long. */
const TOP_WINDOW_MS = 4000;
/**
 * Impact's dip ends once the hands have climbed back this share of the way
 * from its bottom toward the top's height.
 */
const DIP_CLIMB = 0.5;
/** Hands within this many torso lengths of the top's height are still at the top. */
const TOP_PLATEAU = 0.04;
/** Stillness has to last this long to be a setup or a finish, not a pause. */
const STILL_HOLD_MS = 150;

interface Sample {
  readonly t: number;
  x: number;
  y: number;
  /** 1 where the hands were seen, 0 where they were filled in. */
  readonly seen: number;
  readonly torso: number | null;
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const toSamples = (frames: readonly ObservationFrame[]): Sample[] =>
  frames.map((frame) => {
    const points = frame.image;
    const left = points?.[LEFT_WRIST];
    const right = points?.[RIGHT_WRIST];
    const seen =
      !!left && !!right && left.visibility >= MIN_VISIBILITY && right.visibility >= MIN_VISIBILITY;
    let torso: number | null = null;
    if (points && points.length > RIGHT_HIP) {
      const sx = (points[LEFT_SHOULDER].x + points[RIGHT_SHOULDER].x) / 2;
      const sy = (points[LEFT_SHOULDER].y + points[RIGHT_SHOULDER].y) / 2;
      const hx = (points[LEFT_HIP].x + points[RIGHT_HIP].x) / 2;
      const hy = (points[LEFT_HIP].y + points[RIGHT_HIP].y) / 2;
      torso = Math.hypot(sx - hx, sy - hy) || null;
    }
    return {
      t: frame.timestampMs,
      x: seen ? (left!.x + right!.x) / 2 : Number.NaN,
      y: seen ? (left!.y + right!.y) / 2 : Number.NaN,
      seen: seen ? 1 : 0,
      torso,
    };
  });

/** Holes filled by straight lines between the seen frames either side. */
const fillGaps = (samples: Sample[]) => {
  const seenIndices = samples.flatMap((sample, index) => (sample.seen ? [index] : []));
  if (!seenIndices.length) return false;
  for (let index = 0; index < samples.length; index += 1) {
    if (samples[index].seen) continue;
    const before = [...seenIndices].reverse().find((i) => i < index);
    const after = seenIndices.find((i) => i > index);
    const a = samples[before ?? after!];
    const b = samples[after ?? before!];
    const span = b.t - a.t;
    const k = span > 0 ? (samples[index].t - a.t) / span : 0;
    samples[index].x = a.x + (b.x - a.x) * k;
    samples[index].y = a.y + (b.y - a.y) * k;
  }
  return true;
};

/** A centred moving average over about `windowMs`, on x and y. */
const smooth = (samples: Sample[], windowMs: number) => {
  const xs = samples.map((s) => s.x);
  const ys = samples.map((s) => s.y);
  const half = windowMs / 2;
  let lo = 0;
  let hi = 0;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const t = samples[index].t;
    while (hi < samples.length && samples[hi].t <= t + half) {
      sumX += xs[hi];
      sumY += ys[hi];
      hi += 1;
    }
    while (samples[lo].t < t - half) {
      sumX -= xs[lo];
      sumY -= ys[lo];
      lo += 1;
    }
    const count = hi - lo;
    samples[index].x = sumX / count;
    samples[index].y = sumY / count;
  }
};

export const findSwingPhases = (frames: readonly ObservationFrame[]): SwingPhases => {
  const none = (failure: string): SwingPhases => ({ phases: {}, failure });
  if (frames.length < 8) return none("The clip is too short to find a swing in.");

  const samples = toSamples(frames);
  if (!fillGaps(samples)) return none("The hands were never seen.");

  const torso = median(samples.flatMap((s) => (s.torso ? [s.torso] : [])));
  if (!torso) return none("The body was never seen clearly enough to measure.");

  const frameMs = (samples[samples.length - 1].t - samples[0].t) / (samples.length - 1) || 1000 / 30;
  // Wide enough to flatten decoders that hand back the same picture for
  // several frames in a row, which otherwise reads as start-stop motion.
  smooth(samples, Math.max(frameMs * 2.5, 120));

  // Hand speed in torso lengths per second, one per sample.
  const speed = samples.map((_, index) => {
    const a = samples[Math.max(0, index - 1)];
    const b = samples[Math.min(samples.length - 1, index + 1)];
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / torso / dt : 0;
  });

  // The swing is the fastest thing in the clip.
  let peak = 0;
  speed.forEach((value, index) => {
    if (value > speed[peak]) peak = index;
  });
  if (speed[peak] < MIN_SWING_SPEED) return none("No swing-speed move in the clip.");

  const indexRange = (fromMs: number, toMs: number) =>
    samples.flatMap((sample, index) => (sample.t >= fromMs && sample.t <= toMs ? [index] : []));
  const argBy = (indices: number[], score: (index: number) => number) =>
    indices.reduce((best, index) => (score(index) > score(best) ? index : best), indices[0]);

  // Top: the highest hands (smallest image y) in the run-up to the peak,
  // then along any plateau there to where the hands start down.
  const beforePeak = indexRange(samples[peak].t - TOP_WINDOW_MS, samples[peak].t);
  const topArrived = argBy(beforePeak, (index) => -samples[index].y);
  let top = topArrived;
  const topY = samples[top].y;
  while (top + 1 < peak && samples[top + 1].y - topY <= TOP_PLATEAU * torso) top += 1;

  // Impact: follow the hands down from the top to the bottom of the dip,
  // stopping once they have clearly climbed back out of it.
  let impact = top;
  for (let index = top + 1; index < samples.length; index += 1) {
    if (samples[index].y > samples[impact].y) impact = index;
    const depth = samples[impact].y - topY;
    if (depth > 0 && samples[impact].y - samples[index].y > depth * DIP_CLIMB) break;
  }
  if (impact === top) return none("The hands never came down from the top.");

  const holdCount = Math.max(2, Math.round(STILL_HOLD_MS / frameMs));
  const isStillFrom = (index: number, direction: 1 | -1) => {
    for (let step = 0; step < holdCount; step += 1) {
      const probe = index + step * direction;
      if (probe < 0 || probe >= samples.length || speed[probe] > STILL_SPEED) return false;
    }
    return true;
  };

  // Setup: back from the top, past any pause there, through the backswing,
  // to the first place the hands were held still. With no stillness in the
  // clip, the start of the clip.
  let cursor = topArrived;
  while (cursor > 0 && speed[cursor] <= STILL_SPEED) cursor -= 1;
  let setup: number | null = null;
  for (let index = cursor; index >= 0; index -= 1) {
    if (isStillFrom(index, -1)) {
      setup = index;
      break;
    }
  }
  const setupFound = setup !== null;
  setup ??= 0;

  // Finish: walking forward from impact, the first held stillness. Failing
  // that, the highest the hands get after impact.
  let finish: number | null = null;
  for (let index = impact + 1; index < samples.length; index += 1) {
    if (isStillFrom(index, 1)) {
      finish = index;
      break;
    }
  }
  const finishFound = finish !== null;
  if (finish === null) {
    const after = samples.flatMap((_, index) => (index > impact ? [index] : []));
    finish = after.length ? argBy(after, (index) => -samples[index].y) : samples.length - 1;
  }

  /** The sample at which the hands have covered `fraction` of the path. */
  const alongPath = (from: number, to: number, fraction: number) => {
    let total = 0;
    for (let index = from + 1; index <= to; index += 1) {
      total += Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
    }
    if (total <= 0) return null;
    let covered = 0;
    for (let index = from + 1; index <= to; index += 1) {
      covered += Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
      if (covered >= total * fraction) return index;
    }
    return to;
  };
  const takeaway = setup < top ? alongPath(setup, top, 0.25) : null;
  const delivery = top < impact ? alongPath(top, impact, 0.75) : null;

  /** Share of frames within ±2 samples where the hands were really seen. */
  const evidence = (index: number) => {
    let seen = 0;
    let count = 0;
    for (let probe = index - 2; probe <= index + 2; probe += 1) {
      if (probe < 0 || probe >= samples.length) continue;
      seen += samples[probe].seen;
      count += 1;
    }
    return count ? seen / count : 0;
  };
  const phase = (index: number | null, discount = 1): SwingPhase | undefined =>
    index === null ? undefined : { timeMs: samples[index].t, confidence: evidence(index) * discount };

  return {
    phases: {
      setup: phase(setup, setupFound ? 1 : 0.4),
      takeaway: phase(takeaway),
      top: phase(top),
      delivery: phase(delivery),
      impact: phase(impact),
      finish: phase(finish, finishFound ? 1 : 0.6),
    },
    failure: null,
  };
};
