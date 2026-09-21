/**
 * Body proportions for the synthetic golfer, and a deterministic RNG.
 *
 * IMPORTANT: these ratios are FIXTURE DATA. They exist so Build 1 can prove
 * the visualisation contract before a detector exists. The real Motion Layer
 * does the opposite -- it MEASURES this golfer's geometry from stable
 * observations and never consults a population table for a bone length.
 *
 * Ratios are the usual Drillis & Contini proportions of standing height,
 * adjusted so the segment chain actually closes: thigh + shank spans hip to
 * ankle exactly, which matters because the synthetic skeleton is measured to
 * produce the BodyModel and a chain that does not close would show up as a
 * body model that disagrees with its own poses.
 */

/** Ratios of standing height. */
export interface Proportions {
  readonly heightM: number;
  readonly ankleY: number;
  readonly kneeY: number;
  readonly hipY: number;
  readonly shoulderY: number;
  readonly neckY: number;
  readonly headY: number;
  readonly shoulderHalfWidth: number;
  readonly hipHalfWidth: number;
  readonly upperArm: number;
  readonly foreArm: number;
  readonly handLength: number;
  readonly thigh: number;
  readonly shank: number;
  readonly heelBehind: number;
  readonly toeAhead: number;
  readonly stanceWidth: number;
}

export const proportionsForHeight = (heightM: number): Proportions => {
  const h = heightM;
  const ankleY = 0.039 * h;
  const kneeY = 0.285 * h;
  const hipY = 0.53 * h;
  const shoulderY = 0.818 * h;

  return {
    heightM: h,
    ankleY,
    kneeY,
    hipY,
    shoulderY,
    neckY: 0.85 * h,
    headY: 0.935 * h,
    shoulderHalfWidth: 0.115 * h,
    hipHalfWidth: 0.055 * h,
    upperArm: 0.186 * h,
    foreArm: 0.146 * h,
    handLength: 0.045 * h,
    // Derived rather than tabulated, so hip -> knee -> ankle closes exactly.
    thigh: hipY - kneeY,
    shank: kneeY - ankleY,
    heelBehind: 0.045 * h,
    toeAhead: 0.107 * h,
    stanceWidth: 0.22 * h,
  };
};

/**
 * mulberry32. Small, fast, and -- the only property that matters here --
 * deterministic, so a synthetic sequence with the same seed is byte-identical
 * across runs and a test that fails keeps failing.
 */
export const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Box-Muller, so injected noise is Gaussian rather than boxy. */
export const gaussian = (rng: () => number): number => {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
