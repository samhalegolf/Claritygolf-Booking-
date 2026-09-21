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
  /**
   * Whether `gravityTiltDeg` was measured at all.
   *
   * False means no frame in the clip had the golfer standing on both feet, so
   * there was no horizontal line to measure against and the world is level
   * only because nothing was done to it. That is a different thing from a
   * measured zero, and conflating the two is how a badly tilted clip passes
   * for a well-shot one.
   */
  readonly gravityTiltIsMeasured: boolean;
  /**
   * How far the world was pitched to keep the golfer off the falling-over
   * boundary, in degrees. Positive tips the top of the body toward the heels.
   *
   * THE ONE TILT THE STANCE LINE CANNOT SEE
   *
   * `gravityTiltDeg` is measured from the line between two flat feet, which is
   * horizontal. One line gives one constraint, so it fixes the ROLL and says
   * nothing about the pitch -- a rotation about that same line leaves it
   * exactly where it was.
   *
   * What does see the pitch is the golfer's own balance. A person standing on
   * both feet has their centre of mass over those feet; past the toes or
   * behind the heels they are not standing, they are falling. That edge is
   * the FALLING-OVER BOUNDARY, and it is physics rather than technique.
   *
   * So when the reconstructed mass lands outside it, the scene is not merely
   * unlikely -- it is impossible, and the smallest pitch that brings the mass
   * back to the boundary is a hard lower bound on how far the camera was
   * tilted. That angle is applied here, and it is the SMALLEST one the
   * evidence forces: usually zero, and never more than the golfer's own
   * balance demands.
   *
   * It is a lower bound, not a solution. A camera tilted five degrees may
   * only be caught out by two, because the reading has to travel all the way
   * past the toes before it becomes impossible at all. Corrected, the scene
   * is no longer impossible; it is not thereby right.
   */
  readonly pitchCorrectionDeg: number;
  /**
   * Where `pitchCorrectionDeg` came from.
   *
   * The two routes are not the same kind of claim and should never be read as
   * though they were.
   *
   *   "falling-over-boundary"  A LOWER BOUND from the swing itself, free and
   *                            always available. The camera was tilted at
   *                            least this much; usually it was tilted more.
   *
   *   "standing-shot"          An ESTIMATE from a second clip of the golfer
   *                            standing still, good to about a degree, and
   *                            only as good as the instruction being followed.
   *
   * Averaging a bound with an estimate would produce a number that is neither,
   * so they are kept apart and the provenance travels with the value.
   */
  readonly pitchCorrectionSource: "none" | "falling-over-boundary" | "standing-shot";
}

export const clampUnit = (value: number): Unit =>
  value < 0 ? 0 : value > 1 ? 1 : Number.isFinite(value) ? value : 0;
