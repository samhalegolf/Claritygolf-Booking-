/**
 * The synthetic swing, as a keyframe schedule.
 *
 * A NOTE ON THE ARCHITECTURAL RULE
 *
 * The plan forbids encoding assumptions about what a golf swing is supposed
 * to look like -- INSIDE THE RECONSTRUCTION ENGINE. This file is not the
 * reconstruction engine. It is fixture data: a plausible swing, written down,
 * so the 3D Space can be proved before a detector exists.
 *
 * That distinction is the reason `synthetic/` may not be imported by
 * `motion/`, and the reason this file is full of golf and the Motion Layer
 * is not. If a reconstruction ever needs a number from here, something has
 * gone wrong.
 *
 * Angles are degrees in the table and converted once on the way out; a table
 * of radians is unreadable and unreviewable.
 */

export interface SwingKey {
  /** Seconds from the start of the clip. */
  readonly t: number;
  /**
   * Arm angle in the swing plane, degrees. 0 is address. Positive is the
   * backswing direction (toward the trail foot); negative is through.
   */
  readonly theta: number;
  /**
   * Hub-to-clubhead radius as a fraction of its address value. It shortens
   * toward the top because the wrists cock -- the arm and club fold, so the
   * clubhead comes closer to the hub. The wrist angle itself is not
   * specified; it falls out of the two-bone solve.
   */
  readonly radius: number;
  /** World yaw of the pelvis, degrees. Positive is away from the target. */
  readonly pelvisYaw: number;
  /** World yaw of the thorax, degrees. Its lead over the pelvis is the separation. */
  readonly thoraxYaw: number;
  /** Forward lean of the spine from vertical, degrees. */
  readonly spineTilt: number;
  /** Side bend of the thorax, degrees. Negative leans away from the target. */
  readonly thoraxRoll: number;
  /** Lateral shift of the pelvis along the stance line, metres. */
  readonly shiftX: number;
  /** Height of the trail heel above the ground, metres. */
  readonly trailHeelLift: number;
  /** Height of the lead heel above the ground, metres. */
  readonly leadHeelLift: number;
}

/**
 * A right-handed swing, roughly 2.4 seconds.
 *
 * The asymmetry is the point: the backswing takes ~0.8s and the downswing
 * ~0.25s. A symmetric schedule produces motion that a smoothing filter cannot
 * be tested against, because nothing in it is fast enough to be wrongly
 * flattened.
 */
export const RIGHT_HANDED_SWING: readonly SwingKey[] = [
  // Address, held. Gives the world-frame anchor a genuinely still window to
  // find, which is what `anchorIsStable` is about.
  { t: 0.0, theta: 0, radius: 1.0, pelvisYaw: 0, thoraxYaw: 0, spineTilt: 32, thoraxRoll: 0, shiftX: 0, trailHeelLift: 0, leadHeelLift: 0 },
  { t: 0.4, theta: 0, radius: 1.0, pelvisYaw: 0, thoraxYaw: 0, spineTilt: 32, thoraxRoll: 0, shiftX: 0, trailHeelLift: 0, leadHeelLift: 0 },

  // Takeaway and backswing.
  { t: 0.7, theta: 55, radius: 0.94, pelvisYaw: 12, thoraxYaw: 32, spineTilt: 32, thoraxRoll: -2, shiftX: 0.02, trailHeelLift: 0, leadHeelLift: 0.004 },
  { t: 1.05, theta: 130, radius: 0.78, pelvisYaw: 30, thoraxYaw: 72, spineTilt: 31, thoraxRoll: -5, shiftX: 0.04, trailHeelLift: 0, leadHeelLift: 0.018 },
  { t: 1.22, theta: 162, radius: 0.68, pelvisYaw: 36, thoraxYaw: 92, spineTilt: 30, thoraxRoll: -6, shiftX: 0.05, trailHeelLift: 0, leadHeelLift: 0.03 },

  // Transition. The pelvis reverses while the thorax is still going back, so
  // separation peaks just after the top rather than at it.
  { t: 1.3, theta: 158, radius: 0.7, pelvisYaw: 26, thoraxYaw: 90, spineTilt: 30, thoraxRoll: -8, shiftX: 0.01, trailHeelLift: 0, leadHeelLift: 0.022 },

  // Downswing. Fast.
  { t: 1.42, theta: 95, radius: 0.8, pelvisYaw: 2, thoraxYaw: 55, spineTilt: 31, thoraxRoll: -12, shiftX: -0.03, trailHeelLift: 0.012, leadHeelLift: 0.004 },
  { t: 1.53, theta: 0, radius: 1.0, pelvisYaw: -38, thoraxYaw: -8, spineTilt: 30, thoraxRoll: -14, shiftX: -0.06, trailHeelLift: 0.04, leadHeelLift: 0 },

  // Through and up.
  { t: 1.68, theta: -75, radius: 0.95, pelvisYaw: -62, thoraxYaw: -48, spineTilt: 26, thoraxRoll: -10, shiftX: -0.08, trailHeelLift: 0.1, leadHeelLift: 0 },
  { t: 1.9, theta: -150, radius: 0.8, pelvisYaw: -85, thoraxYaw: -85, spineTilt: 16, thoraxRoll: -5, shiftX: -0.09, trailHeelLift: 0.2, leadHeelLift: 0 },
  { t: 2.05, theta: -178, radius: 0.76, pelvisYaw: -95, thoraxYaw: -100, spineTilt: 8, thoraxRoll: -3, shiftX: -0.1, trailHeelLift: 0.26, leadHeelLift: 0 },

  // Finish, held.
  { t: 2.4, theta: -178, radius: 0.76, pelvisYaw: -95, thoraxYaw: -100, spineTilt: 8, thoraxRoll: -3, shiftX: -0.1, trailHeelLift: 0.26, leadHeelLift: 0 },
];

/** Impact, by construction: the moment the schedule brings theta back to 0. */
export const RIGHT_HANDED_IMPACT_SECONDS = 1.53;

export type InterpolatedKey = Omit<SwingKey, "t">;

const KEY_FIELDS = [
  "theta",
  "radius",
  "pelvisYaw",
  "thoraxYaw",
  "spineTilt",
  "thoraxRoll",
  "shiftX",
  "trailHeelLift",
  "leadHeelLift",
] as const;

/**
 * Sample the schedule at an arbitrary time.
 *
 * Smootherstep rather than linear so the second derivative is continuous at
 * the keys. Linear interpolation would put a velocity discontinuity at every
 * keyframe, and a velocity discontinuity is exactly the artefact the Motion
 * Layer's jump detection is meant to find -- synthetic data should not
 * manufacture the very fault it is used to test for.
 */
export const sampleSwing = (
  keys: readonly SwingKey[],
  timeSeconds: number
): InterpolatedKey => {
  if (keys.length === 0) throw new Error("sampleSwing needs at least one key");
  if (timeSeconds <= keys[0].t) return stripTime(keys[0]);

  const last = keys[keys.length - 1];
  if (timeSeconds >= last.t) return stripTime(last);

  let upper = 1;
  while (upper < keys.length && keys[upper].t <= timeSeconds) upper += 1;
  const a = keys[upper - 1];
  const b = keys[upper];

  const span = b.t - a.t;
  const raw = span <= 0 ? 0 : (timeSeconds - a.t) / span;
  const t = raw * raw * raw * (raw * (raw * 6 - 15) + 10);

  const out: Record<string, number> = {};
  for (const field of KEY_FIELDS) {
    out[field] = a[field] + (b[field] - a[field]) * t;
  }
  return out as unknown as InterpolatedKey;
};

const stripTime = (key: SwingKey): InterpolatedKey => {
  const { t: _ignored, ...rest } = key;
  return rest;
};

export const durationSeconds = (keys: readonly SwingKey[]): number =>
  keys.length === 0 ? 0 : keys[keys.length - 1].t;
