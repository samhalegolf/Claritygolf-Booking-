/**
 * Units and frames of reference.
 *
 * Stated once here and relied on by every layer. If you find yourself
 * wondering "is this metres or normalised?" the answer is in this file, and
 * if the answer isn't here then the value crossing that boundary is a bug.
 *
 * WORLD SPACE (everything inside a ClarityFrame)
 *
 *   - Right-handed, Y-up, metres.
 *   - Y is vertical, opposing gravity. The ground plane is Y = 0.
 *   - The origin sits on the ground plane beneath the reference support
 *     centre (see `WorldFrameAnchor`), so a frame's coordinates are relative
 *     to where the golfer was standing, not to where the camera happened to
 *     be.
 *   - X and Z are fixed by the measured stance line, not by a target. See
 *     `WorldFrameAnchor` below for why that distinction matters.
 *
 * OBSERVATION SPACE (everything a detector produces)
 *
 *   - Image coordinates are normalised 0..1, origin top-left, Y DOWN.
 *   - World-landmark coordinates from MediaPipe are metres, hip-centred,
 *     Y DOWN, and are NOT in the Clarity world frame.
 *
 * The Y-axis flip between those two is the single most common source of
 * upside-down reconstructions. It is handled in exactly one place --
 * `observe/toObservationFrame.ts` -- and nowhere else.
 */

/** Metres. */
export type Metres = number;

/** Milliseconds from the start of the source media. */
export type TimestampMs = number;

/** A unit interval, 0..1. Confidences and normalised ratios use this. */
export type Unit = number;

/** A point or vector in Clarity world space. Metres, Y-up, right-handed. */
export type Vec3 = readonly [x: number, y: number, z: number];

/** A rotation, as a quaternion in (x, y, z, w) order to match three.js. */
export type Quat = readonly [x: number, y: number, z: number, w: number];

export const ZERO_VEC3: Vec3 = [0, 0, 0];
export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/**
 * How Clarity world space was pinned to the golfer.
 *
 * The plan's rule is that reconstruction must not encode assumptions about
 * what a golf swing looks like. A coordinate convention is not such an
 * assumption -- but "+X points at the target" would be, because it requires
 * knowing where the target is, which the video does not tell us.
 *
 * So the axes are derived from something we actually measure: the line
 * through the two feet at the anchor frame.
 *
 *   +X  along the stance line, from the left foot toward the right foot
 *   +Y  up
 *   +Z  X cross Y -- roughly "in front of the golfer", the direction the
 *       toes point
 *
 * Camera presets are then defined against these measured axes rather than
 * against an assumed target direction. "Face-on" means looking down -Z at
 * the stance line; it does not mean the golfer is aiming anywhere in
 * particular.
 */
export interface WorldFrameAnchor {
  /** The frame index whose stance defined the axes. */
  readonly anchorFrameIndex: number;
  /** Stance width at the anchor frame, metres, ankle to ankle. */
  readonly stanceWidthM: Metres;
  /**
   * True when the anchor was chosen from a genuinely still, two-feet-visible
   * frame. False means the axes were pinned from the best available frame and
   * every world coordinate inherits that doubt.
   */
  readonly anchorIsStable: boolean;
  /**
   * How far the camera was tilted, in degrees, as measured from the golfer's
   * own stance and corrected for.
   *
   * WHY THIS IS NOT TAKEN FROM THE IMAGE
   *
   * Nothing says a phone on a tripod is level, and a detector's world
   * landmarks inherit whatever tilt it had: their "down" is the image's down,
   * not gravity's. Assuming the two agree is assuming something nobody
   * checked.
   *
   * It matters more than it sounds. The ground HEIGHT barely moves under
   * tilt, so the reconstruction looks fine -- but every signal that compares
   * a position at height h against the ground shifts by h·tan(tilt). Measured
   * on a clip tilted two degrees, a balanced 47/53 address read as 38/62, and
   * at five degrees as 24/76. A golfer who is square appears to be leaning on
   * their trail foot.
   *
   * So it is measured from anatomy instead: the line between the ankles is
   * horizontal when both feet are flat on the ground, and that is a fact
   * about the golfer rather than about the camera.
   */
  readonly gravityTiltDeg: number;
}

export const clampUnit = (value: number): Unit =>
  value < 0 ? 0 : value > 1 ? 1 : Number.isFinite(value) ? value : 0;
