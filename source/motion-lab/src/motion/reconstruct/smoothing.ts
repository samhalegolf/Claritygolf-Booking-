/**
 * Smoothing that responds to evidence, not to how the movement looks.
 *
 * The plan's rule: do not smooth because the motion is visually ugly. Smooth
 * because of low confidence, implausible single-frame jumps, dropout,
 * reacquisition or measurement noise. Genuine rapid movement and acceleration
 * must survive intact.
 *
 * TWO MECHANISMS, BOTH NEEDED
 *
 * 1. A LOCAL QUADRATIC FIT rather than an average. This is what makes the
 *    rule achievable at all. A moving average pulls the middle of any curve
 *    toward its chord, so it flattens acceleration by construction -- the
 *    faster and harder the motion, the more it destroys, which is exactly
 *    backwards. A quadratic reproduces constant acceleration EXACTLY, so a
 *    genuine downswing passes through untouched while noise, which is not
 *    quadratic, does not.
 *
 * 2. A PER-SAMPLE STRENGTH. Even a well-behaved filter should not be pulling
 *    on a sample the detector was certain about. Each frame's output is
 *    blended between its input and the fit by a strength that comes from the
 *    evidence for that frame. A confident observation keeps itself; a
 *    reconstructed or low-visibility one yields.
 *
 * The result: on clean, fast data the filter is close to the identity. It
 * only does work where the evidence is weak, which is the only place it is
 * entitled to.
 */

import type { Unit, Vec3 } from "../../contracts";
import { clamp, lerpVec } from "../../contracts";

export interface SmoothingOptions {
  /**
   * Half-width of the fitting window, in frames. Small on purpose: a window
   * wide enough to average out noise thoroughly is also wide enough to span a
   * real change of direction.
   */
  readonly halfWindow?: number;
}

const DEFAULTS = { halfWindow: 3 } as const;

/**
 * Weighted least-squares quadratic through a window, evaluated at the centre.
 *
 * Solves for (a, b, c) in p(t) = a + b·t + c·t² over the window, with t
 * measured in frames from the centre, then returns p(0) = a. Each axis is
 * independent, so the fit is done three times on scalars rather than once on
 * vectors.
 */
const fitQuadraticAtCentre = (
  values: readonly number[],
  weights: readonly number[],
  centre: number,
  halfWindow: number
): number => {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;

  const from = Math.max(0, centre - halfWindow);
  const to = Math.min(values.length - 1, centre + halfWindow);

  for (let index = from; index <= to; index += 1) {
    const weight = weights[index];
    if (weight <= 0) continue;
    const t = index - centre;
    const tt = t * t;
    const value = values[index];

    s0 += weight;
    s1 += weight * t;
    s2 += weight * tt;
    s3 += weight * tt * t;
    s4 += weight * tt * tt;
    t0 += weight * value;
    t1 += weight * value * t;
    t2 += weight * value * tt;
  }

  /*
   * Solve the 3x3 normal equations by Cramer's rule.
   *
   * A near-zero determinant means the window has too few distinct samples to
   * define a parabola -- one or two points, or everything at one offset. The
   * honest answer there is the sample itself, not a fit through nothing.
   */
  const det =
    s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-12) return values[centre];

  const detA =
    t0 * (s2 * s4 - s3 * s3) - s1 * (t1 * s4 - s3 * t2) + s2 * (t1 * s3 - s2 * t2);
  return detA / det;
};

export interface SmoothInput {
  readonly positions: readonly Vec3[];
  /**
   * How much each sample is trusted, 0..1. Drives BOTH the fit's weights and
   * how far the output is allowed to move from its input.
   */
  readonly trust: readonly Unit[];
  /**
   * Per-frame smoothing strength, 0..1. Zero leaves a sample exactly alone.
   * Usually `1 - trust`, but a frame next to a reacquisition earns more than
   * its own visibility suggests, so it is passed in rather than derived here.
   */
  readonly strength: readonly Unit[];
}

export interface SmoothResult {
  readonly positions: readonly Vec3[];
  /** How far each sample moved, metres. Feeds provenance and confidence. */
  readonly correctionM: readonly number[];
}

export const smoothTrack = (
  input: SmoothInput,
  options: SmoothingOptions = {}
): SmoothResult => {
  const halfWindow = options.halfWindow ?? DEFAULTS.halfWindow;
  const count = input.positions.length;
  if (count === 0) return { positions: [], correctionM: [] };

  const axes: number[][] = [[], [], []];
  for (const position of input.positions) {
    axes[0].push(position[0]);
    axes[1].push(position[1]);
    axes[2].push(position[2]);
  }

  const positions: Vec3[] = [];
  const correctionM: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const strength = clamp(input.strength[index] ?? 0, 0, 1);

    if (strength <= 0) {
      positions.push(input.positions[index]);
      correctionM.push(0);
      continue;
    }

    const fitted: Vec3 = [
      fitQuadraticAtCentre(axes[0], input.trust, index, halfWindow),
      fitQuadraticAtCentre(axes[1], input.trust, index, halfWindow),
      fitQuadraticAtCentre(axes[2], input.trust, index, halfWindow),
    ];

    const original = input.positions[index];
    const blended = lerpVec(original, fitted, strength);
    positions.push(blended);
    correctionM.push(
      Math.hypot(
        blended[0] - original[0],
        blended[1] - original[1],
        blended[2] - original[2]
      )
    );
  }

  return { positions, correctionM };
};
