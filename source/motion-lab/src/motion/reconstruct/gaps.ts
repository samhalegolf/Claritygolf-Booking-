/**
 * Bridging a gap using evidence from BOTH sides.
 *
 * This is the one advantage a recorded video has over a live camera, and the
 * plan asks for it explicitly: when a joint disappears at frame 100 and comes
 * back at frame 120, we already know where it went. A live tracker can only
 * extrapolate forwards and hope; here the far side of the gap is sitting
 * there, and using it is the difference between a reconstruction and a guess.
 *
 * WHAT "SIMPLEST PLAUSIBLE JOURNEY" MEANS HERE
 *
 * A cubic Hermite through the two endpoints, with the tangents taken from the
 * observed motion just before and just after. Among all paths that meet the
 * endpoints and their velocities, that is the one with the least total
 * acceleration -- the least eventful trip consistent with the evidence.
 *
 * Crucially it is NOT a golf-shaped path. No swing plane, no expected hand
 * arc, no assumption about direction of travel. If the golfer did something
 * strange inside the gap and the endpoints say so, the endpoints win.
 *
 * WHY THE TANGENTS FADE ON LONG GAPS
 *
 * A velocity measured at the edge of a gap says a lot about the next two
 * frames and very little about the next forty. Trusting it over a long gap
 * makes the curve shoot out and loop back -- a confident, elaborate,
 * completely invented journey. So the tangents are scaled down as the gap
 * grows, and a long gap degrades toward a straight line: still wrong, but
 * wrong in the least eventful way, and its confidence says so.
 */

import type { Vec3 } from "../../contracts";
import { add, lerpVec, scale } from "../../contracts";
import type { Gap, Track } from "./tracks";

export interface BridgeOptions {
  /**
   * Gap length, in frames, at which the endpoint velocities are given half
   * their weight.
   *
   * Measured rather than reasoned about. Across gaps of 4 to 45 frames, with
   * and without 12mm of detection noise, full-weight tangents win on clean
   * data and lose on noisy short gaps, and the crossover sits around twenty.
   * The first version used six, which was a guess and cost about 40% accuracy
   * on a nine-frame gap through the downswing.
   */
  readonly tangentHalfLifeFrames?: number;
}

const DEFAULTS = { tangentHalfLifeFrames: 20 } as const;

export interface BridgedPoint {
  readonly frame: number;
  readonly position: Vec3;
  /** How far into the gap this frame is. 1 is the first reconstructed frame. */
  readonly depth: number;
}

export interface BridgeResult {
  readonly points: readonly BridgedPoint[];
  /**
   * How the gap was closed:
   *   "bridged"      both sides known -- the strong case
   *   "extrapolated" only one side known -- a forward or backward guess
   *   "unbridged"    neither side known, nothing to say
   */
  readonly kind: "bridged" | "extrapolated" | "unbridged";
  /** How much the endpoint velocities were trusted, 0..1. */
  readonly tangentWeight: number;
}

/**
 * Velocity just inside a gap edge, per frame.
 *
 * A least-squares slope over several samples rather than the difference
 * between two, and the difference matters more than it sounds. A two-sample
 * estimate carries the full detection noise of both, amplified by dividing by
 * one frame -- with 12mm noise that is nearly a metre per second of error in
 * a quantity then projected right across the gap. Measured over four samples
 * the noise roughly halves, and that is what makes it safe to trust the
 * tangents rather than shrink them.
 *
 * Only CONTIGUOUS observed samples inward from the edge are used. Reaching
 * across an earlier hole to find a fourth sample would measure a velocity the
 * joint never had.
 */
const VELOCITY_SAMPLES = 4;

const velocityAt = (track: Track, index: number, direction: -1 | 1): Vec3 => {
  const offsets: number[] = [];
  const points: Vec3[] = [];

  for (let step = 0; step < VELOCITY_SAMPLES; step += 1) {
    const at = index + direction * step;
    const sample = track.samples[at];
    if (!sample) break;
    // Offsets in real frame numbers, so the slope is per frame regardless of
    // which side of the gap we are on.
    offsets.push(at - index);
    points.push(sample.position);
  }

  if (points.length < 2) return [0, 0, 0];

  const meanOffset = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
  let denominator = 0;
  for (const offset of offsets) denominator += (offset - meanOffset) ** 2;
  if (denominator < 1e-12) return [0, 0, 0];

  const slope: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const meanValue =
      points.reduce((sum, point) => sum + point[axis], 0) / points.length;
    let numerator = 0;
    for (let i = 0; i < points.length; i += 1) {
      numerator += (offsets[i] - meanOffset) * (points[i][axis] - meanValue);
    }
    slope[axis] = numerator / denominator;
  }

  // Always expressed as "per frame, forwards in time".
  return slope;
};

const hermite = (p0: Vec3, p1: Vec3, m0: Vec3, m1: Vec3, t: number): Vec3 => {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return add(
    add(scale(p0, h00), scale(m0, h10)),
    add(scale(p1, h01), scale(m1, h11))
  );
};

export const bridgeGap = (
  track: Track,
  gap: Gap,
  options: BridgeOptions = {}
): BridgeResult => {
  const halfLife = options.tangentHalfLifeFrames ?? DEFAULTS.tangentHalfLifeFrames;

  const before = gap.before !== null ? track.samples[gap.before] : null;
  const after = gap.after !== null ? track.samples[gap.after] : null;

  /* ---- neither side seen: nothing to say ---- */

  if (!before && !after) {
    return { points: [], kind: "unbridged", tangentWeight: 0 };
  }

  /* ---- one side only: hold position ---- */

  if (!before || !after || gap.before === null || gap.after === null) {
    const anchor = (before ?? after)!;
    /*
     * Held, not extrapolated along the last velocity.
     *
     * A joint that vanished while moving at 20 m/s would, on its last known
     * velocity, be a metre away within three frames and off the planet within
     * a second. The plan's rule is not to invent movement indefinitely, and a
     * clip that ends mid-swing is exactly where that temptation arises.
     * Holding still is visibly wrong, which is the point: its provenance says
     * "extrapolated" and its confidence falls frame by frame.
     */
    return {
      points: Array.from({ length: gap.length }, (_unused, offset) => ({
        frame: gap.start + offset,
        position: anchor.position,
        depth: offset + 1,
      })),
      kind: "extrapolated",
      tangentWeight: 0,
    };
  }

  /* ---- both sides seen: the strong case ---- */

  const span = gap.after - gap.before;

  // Velocities are per frame; the Hermite parameter runs 0..1 across the
  // whole span, so the tangents scale by the span to stay consistent.
  const tangentWeight = halfLife / (halfLife + gap.length);
  const m0 = scale(velocityAt(track, gap.before, -1), span * tangentWeight);
  const m1 = scale(velocityAt(track, gap.after, 1), span * tangentWeight);

  const points: BridgedPoint[] = [];
  for (let offset = 0; offset < gap.length; offset += 1) {
    const frame = gap.start + offset;
    const t = (frame - gap.before) / span;
    points.push({
      frame,
      position: hermite(before.position, after.position, m0, m1, t),
      depth: offset + 1,
    });
  }

  return { points, kind: "bridged", tangentWeight };
};

/** Straight line between the endpoints. The comparison a bridge is judged against. */
export const linearBridge = (track: Track, gap: Gap): BridgedPoint[] => {
  if (gap.before === null || gap.after === null) return [];
  const before = track.samples[gap.before];
  const after = track.samples[gap.after];
  if (!before || !after) return [];

  const span = gap.after - gap.before;
  return Array.from({ length: gap.length }, (_unused, offset) => {
    const frame = gap.start + offset;
    return {
      frame,
      position: lerpVec(before.position, after.position, (frame - gap.before!) / span),
      depth: offset + 1,
    };
  });
};
