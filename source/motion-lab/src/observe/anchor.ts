/**
 * Pinning observations into Clarity world space.
 *
 * THE PROBLEM THIS SOLVES, AND THE COST IT PAYS
 *
 * MediaPipe's world landmarks are metres, which is what makes 3D
 * reconstruction possible at all -- but their origin is RE-CENTRED ON THE HIP
 * MIDPOINT EVERY FRAME. Global translation is simply not in the data. The
 * hips are at the origin whether the golfer is standing still or walking
 * away.
 *
 * So something has to be pinned, and the choice is not free:
 *
 *   Pin the hips (do nothing).  The feet appear to slide around under a
 *                               stationary pelvis. Sway reads as the ground
 *                               moving. Unusable.
 *
 *   Pin the feet.               The feet stay planted and the hips move over
 *                               them, which is what a swing looks like. The
 *                               cost is that genuine translation of the whole
 *                               golfer across the ground is removed -- if they
 *                               step, the step vanishes.
 *
 * The feet are pinned, because within a swing the relative geometry is what
 * matters and the feet really do stay put. The cost is recorded on the
 * sequence rather than buried: `anchorIsStable` says whether a genuinely
 * still, two-feet-visible frame was found, and everything downstream inherits
 * that doubt.
 *
 * WHAT IS ASSUMED, AND WHAT IS NOT
 *
 * Assumed: the golfer is standing on the ground, and the ground is level.
 * Those are physical facts about the scene, not claims about technique.
 *
 * Not assumed: anything about how a swing should look. The rotation into the
 * stance frame is measured from the two ankles at the anchor frame. No target
 * direction is inferred, because the video does not contain one.
 */

import type { Vec3, WorldFrameAnchor } from "../contracts";
import {
  clampUnit,
  distance,
  dot,
  normalise,
  projectToGround,
  qFromUnitVectors,
  qMultiply,
  qRotate,
  scale,
  sub,
  type Quat,
} from "../contracts";
import type {
  CameraObservationFrame,
  CameraObservationSequence,
  ObservedJoint,
  WorldObservationFrame,
  WorldObservationSequence,
} from "./observation";

/** Foot points that can rest on the ground. */
const FOOT_JOINTS = ["leftHeel", "leftToe", "rightHeel", "rightToe"] as const;

export interface AnchorOptions {
  /**
   * How far into the clip to look for the anchor. Address is usually near the
   * start, but a clip that begins mid-waggle has its stillest moment later,
   * so this is a search window rather than a rule.
   */
  readonly searchFraction?: number;
  /**
   * Metres of per-joint movement between frames below which a frame counts as
   * still. Generous: the anchor needs a frame that is not MID-SWING, not one
   * that is perfectly frozen.
   */
  readonly stillnessThresholdM?: number;
  /**
   * Pitch the world by this many degrees about the stance line, on top of the
   * roll measured from the feet.
   *
   * Not measured here, and cannot be: the evidence for it is the golfer's
   * balance, which needs a mass model, which lives in the Motion Layer --
   * and this layer may not import it. So the number arrives from outside,
   * already derived, and this option is the hole it is poured into. See
   * `WorldFrameAnchor.pitchCorrectionDeg`.
   */
  readonly pitchCorrectionDeg?: number;
  /**
   * Where the caller got `pitchCorrectionDeg` from. Recorded, never checked --
   * this layer has no way to verify it and does not pretend to.
   */
  readonly pitchCorrectionSource?: WorldFrameAnchor["pitchCorrectionSource"];
}

const DEFAULTS = {
  searchFraction: 0.45,
  stillnessThresholdM: 0.012,
} as const;

/* ------------------------- finding the anchor ------------------------- */

/** Mean movement of the joints both frames share. Frames with no overlap score Infinity. */
const motionBetween = (
  previous: CameraObservationFrame,
  current: CameraObservationFrame
): number => {
  let total = 0;
  let count = 0;
  for (const [joint, observed] of Object.entries(current.joints) as [
    string,
    ObservedJoint,
  ][]) {
    const before = previous.joints[joint as keyof typeof previous.joints];
    if (!before) continue;
    total += distance(observed.position as Vec3, before.position as Vec3);
    count += 1;
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count;
};

interface AnchorChoice {
  readonly index: number;
  readonly stable: boolean;
  readonly motion: number;
}

/**
 * The stillest frame in the search window that can see both feet.
 *
 * Both ankles are required, not preferred: the whole purpose of the anchor is
 * to measure the stance line, and a stance line from one ankle is not a line.
 */
export const findAnchorFrame = (
  frames: readonly CameraObservationFrame[],
  options: AnchorOptions = {}
): AnchorChoice => {
  const searchFraction = options.searchFraction ?? DEFAULTS.searchFraction;
  const threshold = options.stillnessThresholdM ?? DEFAULTS.stillnessThresholdM;
  const limit = Math.max(1, Math.floor(frames.length * searchFraction));

  let best: AnchorChoice | null = null;

  for (let index = 0; index < limit; index += 1) {
    const frame = frames[index];
    if (!frame.joints.leftAnkle || !frame.joints.rightAnkle) continue;

    const motion = index === 0 ? 0 : motionBetween(frames[index - 1], frame);
    if (!best || motion < best.motion) {
      best = { index, stable: motion <= threshold, motion };
    }
  }

  if (best) return best;

  // Nothing in the window saw both feet. Fall back to the frame that saw the
  // most of the body, and say plainly that the axes are not trustworthy --
  // silently anchoring to a half-seen body would poison every coordinate
  // downstream with no trace of why.
  let fallback = 0;
  let mostJoints = -1;
  for (let index = 0; index < frames.length; index += 1) {
    const count = Object.keys(frames[index].joints).length;
    if (count > mostJoints) {
      mostJoints = count;
      fallback = index;
    }
  }
  return { index: fallback, stable: false, motion: Number.POSITIVE_INFINITY };
};

/* ---------------------------- the transform --------------------------- */

/**
 * Rotate about X -- the stance line, once the yaw has been applied.
 *
 * This is the axis a camera pitch turns about, which is why the correction is
 * applied here rather than folded into the levelling quaternion: the levelling
 * is measured in detector axes, and the pitch is measured in world ones.
 */
const rotateX = (point: Vec3, cos: number, sin: number): Vec3 => [
  point[0],
  point[1] * cos - point[2] * sin,
  point[1] * sin + point[2] * cos,
];

/** Rotate about Y. Kept local because the angle is derived, never passed around. */
const rotateY = (point: Vec3, cos: number, sin: number): Vec3 => [
  point[0] * cos + point[2] * sin,
  point[1],
  -point[0] * sin + point[2] * cos,
];

/** Lowest foot point in a frame, or null when no foot was seen. */
const lowestFootY = (
  frame: CameraObservationFrame,
  toWorldAxes: (point: Vec3) => Vec3
): number | null => {
  let lowest: number | null = null;
  for (const joint of FOOT_JOINTS) {
    const observed = frame.joints[joint];
    if (!observed) continue;
    const rotated = toWorldAxes(observed.position as Vec3);
    if (lowest === null || rotated[1] < lowest) lowest = rotated[1];
  }
  return lowest;
};

/**
 * How far from flat this foot is, metres, or null when it cannot be seen.
 *
 * By comparing the heel's height to the toe's, NOT to the ground -- which is
 * the whole point. Detector world coordinates are re-centred on the hips
 * every frame, so there is no ground to compare against until after
 * anchoring, and anchoring is what this is needed for. The difference between
 * two points on the same foot has no such problem: it does not care where the
 * origin is.
 *
 * `orient` is the current best guess at which way is up. It matters: measured
 * in a tilted frame, a flat foot looks tilted and a tilted one can look flat,
 * which is why the levelling that uses this is run twice.
 */
const footTilt = (
  frame: CameraObservationFrame,
  side: "left" | "right",
  orient: (point: Vec3) => Vec3 = (point) => point
): number | null => {
  const heel = side === "left" ? frame.joints.leftHeel : frame.joints.rightHeel;
  const toe = side === "left" ? frame.joints.leftToe : frame.joints.rightToe;
  if (!heel || !toe) return null;
  return Math.abs(
    orient(heel.position as Vec3)[1] - orient(toe.position as Vec3)[1]
  );
};

/** How far the worse of the two feet is from flat. Null when either is unseen. */
const frameFlatness = (
  frame: CameraObservationFrame,
  orient: (point: Vec3) => Vec3 = (point) => point
): number | null => {
  const left = footTilt(frame, "left", orient);
  const right = footTilt(frame, "right", orient);
  if (left === null || right === null) return null;
  return Math.max(left, right);
};

/**
 * How much more a frame's feet may splay than the clip's own planted
 * baseline before it counts as a heel lift rather than a stance.
 */
const HEEL_LIFT_TOLERANCE_M = 0.02;
/** Where the clip's "both feet down" baseline is read off its own frames. */
const PLANTED_PERCENTILE = 0.2;

interface Planted {
  /** Frame indices with the golfer standing on both feet. */
  readonly indices: readonly number[];
  /** Flatness at each of those indices, metres. Same order. */
  readonly flatness: readonly number[];
}

/**
 * Which frames have the golfer standing on both feet.
 *
 * AGAINST THE CLIP'S OWN FLATTEST FRAMES, NOT AN ABSOLUTE TOLERANCE.
 *
 * The obvious test -- heel within a couple of centimetres of toe -- fails on
 * exactly the clips this function exists to serve, and fails silently. A
 * camera pitched by theta raises the toes above the heels by
 * `footLength * sin(theta)`: 28mm at eight degrees on a 200mm foot, past any
 * sane constant. Every frame in the clip then looks like a heel lift, no
 * frame passes, and `estimateLevelling` returns no samples at all -- so the
 * ROLL, which it could have measured perfectly well, goes unmeasured and is
 * reported as zero.
 *
 * Measured before this was fixed: a clip at 65 degrees of yaw and 8 degrees
 * of pitch recovered its 7.25 degrees of roll; the same clip at 12 degrees of
 * pitch reported 0.00, and the mass then read at three and a half foot
 * lengths past the toes. There was no flag, because nothing had gone wrong
 * from the code's point of view -- it had simply found nothing to measure.
 *
 * A percentile of the clip's own flatness does not care. A camera tilt adds
 * the same splay to every frame, so it moves the baseline and the frames
 * together and cancels. A heel coming up is a CHANGE against that baseline,
 * so it still shows.
 */
const findPlanted = (
  frames: readonly CameraObservationFrame[],
  orient: (point: Vec3) => Vec3 = (point) => point
): Planted => {
  const seen: { index: number; flatness: number }[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame.joints.leftAnkle || !frame.joints.rightAnkle) continue;
    const flatness = frameFlatness(frame, orient);
    if (flatness !== null) seen.push({ index, flatness });
  }
  if (seen.length === 0) return { indices: [], flatness: [] };

  const sorted = seen.map((entry) => entry.flatness).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length * PLANTED_PERCENTILE)];
  const planted = seen.filter((entry) => entry.flatness <= baseline + HEEL_LIFT_TOLERANCE_M);

  return {
    indices: planted.map((entry) => entry.index),
    flatness: planted.map((entry) => entry.flatness),
  };
};

/** How close to the ground a foot point must be to count as bearing weight. */
const CONTACT_TOLERANCE_M = 0.03;

/** Foot points currently on the ground, in rotated camera space. */
const contactPoints = (
  rotated: Partial<Record<string, Vec3>>,
  groundY: number
): Map<string, Vec3> => {
  const contact = new Map<string, Vec3>();
  for (const joint of FOOT_JOINTS) {
    const position = rotated[joint];
    if (!position) continue;
    if (position[1] - groundY <= CONTACT_TOLERANCE_M) contact.set(joint, position);
  }
  return contact;
};

/**
 * Which way is up, measured from the golfer rather than assumed from the
 * camera.
 *
 * THE ASSUMPTION THIS REPLACES
 *
 * A detector's world landmarks are aligned to the IMAGE: their "down" is the
 * bottom of the frame. Taking that as gravity assumes the camera was level,
 * and nothing about a phone on a tripod guarantees that.
 *
 * The cost of being wrong is easy to miss, because the part that looks wrong
 * isn't. Ground HEIGHT survives a tilt almost untouched -- the feet stay
 * coherent relative to each other, so the reconstruction looks right. What
 * breaks is every signal that compares a position at height h against the
 * ground, because each shifts by h·tan(tilt). Measured on a clip tilted two
 * degrees, a balanced 47/53 address read as 38/62; at five degrees, 24/76.
 *
 * WHAT IS MEASURED INSTEAD
 *
 * The line between the ankles, while both feet are flat on level ground, is
 * horizontal. That is a fact about the golfer's anatomy and the ground they
 * are standing on, not about where the camera was.
 *
 * One line gives one constraint: gravity must be perpendicular to it. That
 * fixes the tilt AROUND the optical axis -- the roll -- and leaves the tilt
 * up or down unconstrained. Which is the right trade, because roll is what
 * corrupts the mass and support signals and pitch very nearly does not:
 * `normalisedSeparation` is measured ALONG the stance line, and a pitch
 * rotates about that same line. Measured, five degrees of pitch moved the
 * lead-foot load by one point.
 *
 * So the correction is the smallest rotation that makes the assumed vertical
 * perpendicular to the measured stance. Nothing is invented: where there is
 * no evidence -- pitch -- nothing is changed.
 */
interface Levelling {
  readonly rotation: Quat;
  readonly tiltDeg: number;
  /** How many flat-footed frames the stance line was averaged over. */
  readonly samples: number;
}

const estimateLevelling = (
  frames: readonly CameraObservationFrame[],
  prior: Quat = [0, 0, 0, 1]
): Levelling => {
  const orient = (point: Vec3): Vec3 => qRotate(prior, point);
  /*
   * Averaged over every flat-footed frame, for the same reason the yaw is:
   * planted feet do not move, so each frame is another measurement of one
   * line, and one frame's detection noise on ankles 400mm apart is worth
   * about two degrees all by itself.
   *
   * Flatness is judged on the RAW coordinates here, before any levelling,
   * which is mildly circular -- but a roll mixes x into y and the heel-to-toe
   * vector is almost entirely z, so the test barely notices a tilt it is
   * being used to measure.
   */
  const candidates: { direction: Vec3; flatness: number }[] = [];
  const planted = findPlanted(frames, orient);

  for (let entry = 0; entry < planted.indices.length; entry += 1) {
    const frame = frames[planted.indices[entry]];
    const left = frame.joints.leftAnkle;
    const right = frame.joints.rightAnkle;
    if (!left || !right) continue;

    // NOT ground-projected. The vertical component IS the tilt; projecting it
    // away is exactly how this went unmeasured in the first place.
    const offset = sub(orient(right.position as Vec3), orient(left.position as Vec3));
    if (Math.hypot(...offset) < 1e-4) continue;
    candidates.push({
      direction: normalise(offset),
      flatness: planted.flatness[entry],
    });
  }

  if (candidates.length === 0) {
    return { rotation: prior, tiltDeg: 0, samples: 0 };
  }

  /*
   * The FLATTEST half, not merely the flat-enough ones.
   *
   * "Flat" admits a centimetre of heel lift, which raises that ankle enough
   * to tilt the stance line by nearly two degrees on its own -- and a tilted
   * stance line is precisely the thing being measured. A takeaway spends many
   * frames just inside the tolerance, so the merely-flat set carries a
   * consistent bias toward whichever heel came up first.
   *
   * Taking the flattest half is self-calibrating: a clip filmed with both
   * feet planted throughout loses nothing, and one where the golfer is
   * shuffling keeps only the moments they were still.
   */
  candidates.sort((a, b) => a.flatness - b.flatness);
  const directions = candidates
    .slice(0, Math.max(1, Math.ceil(candidates.length / 2)))
    .map((entry) => entry.direction);
  const samples = directions.length;

  /*
   * The MEDIAN direction, not the mean.
   *
   * "Both feet flat" admits a range: a heel a centimetre off the ground still
   * passes, and that lifts one ankle enough to tilt the stance line by nearly
   * two degrees on its own. A mean lets those frames pull the estimate; the
   * median simply does not see them, because most of a swing has both heels
   * genuinely down. Measured, it halves the error on a perfectly level clip.
   */
  const medianOf = (axis: 0 | 1 | 2) => {
    const values = directions.map((d) => d[axis]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const across = normalise([medianOf(0), medianOf(1), medianOf(2)]);
  const assumedUp: Vec3 = [0, 1, 0];

  // The smallest change to "up" that makes it perpendicular to the stance.
  const corrected = normalise(sub(assumedUp, scale(across, dot(assumedUp, across))));
  if (Math.hypot(...corrected) < 1e-6) {
    // The stance line is parallel to the assumed vertical, which means the
    // body is not being seen as a body. Nothing sensible to do.
    return { rotation: prior, tiltDeg: 0, samples };
  }

  // Composed with whatever was already applied, so a second pass refines the
  // first rather than replacing it.
  const rotation = qMultiply(qFromUnitVectors(corrected, assumedUp), prior);
  const total = qRotate(rotation, [0, 1, 0]);
  const tiltRad = Math.acos(Math.min(1, Math.max(-1, dot(normalise(total), assumedUp))));

  return { rotation, tiltDeg: (tiltRad * 180) / Math.PI, samples };
};

export const anchorSequence = (
  sequence: CameraObservationSequence,
  options: AnchorOptions = {}
): WorldObservationSequence => {
  const frames = sequence.frames;
  const choice = findAnchorFrame(frames, options);
  const anchorFrame = frames[choice.index];

  // The stance line, measured. +X runs from the anatomical left foot toward
  // the right foot -- anatomical because MediaPipe labels sides by the
  // subject, so this holds whichever way the camera was pointing.
  /*
   * Measured across EVERY frame that saw both ankles, not just the anchor
   * frame.
   *
   * This is the largest single source of error in the whole anchoring step,
   * and it is not obvious why. The feet do not move, so the stance line is a
   * constant -- but taken from one frame it carries that frame's detection
   * noise. With 14mm of noise on ankles 400mm apart the angle is wrong by
   * about two degrees, and two degrees rotates a shoulder a metre away by
   * 35mm. Every joint in every frame inherits that as a common-mode error,
   * larger than the per-joint noise the rest of the pipeline works hard to
   * reduce.
   *
   * Averaged over a few hundred frames it falls by an order of magnitude, for
   * nothing. Unit vectors are summed and renormalised rather than averaging
   * angles, which would have to handle the wrap at 180 degrees.
   */
  /*
   * Level the world first, from the golfer's own stance -- see
   * `estimateLevelling`. Everything below measures LEVELLED coordinates, so
   * the yaw is a rotation about true vertical rather than about whatever the
   * camera happened to call vertical.
   */
  /*
   * Twice, because the measurement depends on its own answer: whether a foot
   * is flat is judged by comparing heel height to toe height, and "height"
   * is what is being solved for. One pass gets small tilts exactly right and
   * drifts on large ones -- at ten degrees it over-corrected by a full
   * degree. A second pass, measuring flatness in the frame the first pass
   * produced, removes that.
   */
  const levelling = estimateLevelling(frames, estimateLevelling(frames).rotation);
  const level = (point: Vec3): Vec3 => qRotate(levelling.rotation, point);

  let sumX = 0;
  let sumZ = 0;
  const widths: number[] = [];

  /*
   * Judged in the LEVELLED frame, not the raw one. Whether a foot is flat is
   * a question about heights, and which direction is up is precisely what the
   * levelling has just established -- asking before applying it would be
   * measuring flatness against the camera's idea of down, which is the
   * assumption this whole file exists to remove.
   */
  const plantedFrames = findPlanted(frames, level);

  for (const index of plantedFrames.indices) {
    const frame = frames[index];
    const left = frame.joints.leftAnkle;
    const right = frame.joints.rightAnkle;
    if (!left || !right) continue;
    // Only while BOTH feet are flat. Once a heel lifts, that foot pivots
    // about its toe and its ankle swings forward by up to 200mm -- so the
    // line between the ankles genuinely rotates, and averaging across the
    // follow-through measures the finish rather than the stance.

    const levelledLeft = level(left.position as Vec3);
    const levelledRight = level(right.position as Vec3);
    // Ground-projected here on purpose: the vertical component has already
    // been used, by `estimateLevelling`, to decide which way is up. What is
    // left is the compass bearing of the stance.
    const across = projectToGround([
      levelledRight[0] - levelledLeft[0],
      0,
      levelledRight[2] - levelledLeft[2],
    ]);
    const width = distance([0, 0, 0], across);
    if (width <= 1e-4) continue;

    const unit = normalise(across);
    sumX += unit[0];
    sumZ += unit[2];
    widths.push(width);
  }

  let cos = 1;
  let sin = 0;
  let stanceWidthM = 0;

  if (widths.length > 0) {
    const mean = normalise([sumX, 0, sumZ]);
    // Rotating (a, 0, b) onto (1, 0, 0) about Y needs cos = a, sin = b. The
    // sign is invisible to any test where the golfer stands square to the
    // camera, because then b is zero and both signs agree -- which is why the
    // round trip is also run at 37 degrees.
    cos = mean[0];
    sin = mean[2];

    // Median, not mean: one frame that lost a foot would drag an average, and
    // stance width normalises a signal people will read.
    widths.sort((a, b) => a - b);
    stanceWidthM = widths[Math.floor(widths.length / 2)];
  }

  /*
   * Detector axes to Clarity world axes: level, then face the stance, then
   * take out any pitch the caller established from the golfer's balance.
   *
   * The pitch is LAST because it turns about the stance line, and the stance
   * line is only the X axis once the yaw has been applied. Everything below --
   * the grounding, the contact alignment, the origin -- runs on the output of
   * this function, so the correction reaches all of it for free rather than
   * having to be threaded through each step.
   */
  const pitchRad = ((options.pitchCorrectionDeg ?? 0) * Math.PI) / 180;
  const pitchCos = Math.cos(pitchRad);
  const pitchSin = Math.sin(pitchRad);
  const toWorldAxes = (point: Vec3): Vec3 =>
    pitchRad === 0
      ? rotateY(level(point), cos, sin)
      : rotateX(rotateY(level(point), cos, sin), pitchCos, pitchSin);

  const anchor: WorldFrameAnchor = {
    anchorFrameIndex: choice.index,
    stanceWidthM,
    anchorIsStable: choice.stable && stanceWidthM > 1e-4,
    gravityTiltDeg: levelling.tiltDeg,
    gravityTiltIsMeasured: levelling.samples > 0,
    pitchCorrectionDeg: options.pitchCorrectionDeg ?? 0,
    pitchCorrectionSource: options.pitchCorrectionDeg
      ? (options.pitchCorrectionSource ?? "falling-over-boundary")
      : "none",
  };

  /*
   * Horizontal pinning.
   *
   * The obvious approach -- hold the ankle midpoint still -- is wrong, and
   * wrong in a way that shifts the ENTIRE body. When a heel comes up the foot
   * pivots about its toe, so the ankle swings forward by up to twenty
   * centimetres while the foot has not gone anywhere. Pinning the ankle
   * therefore drags the whole golfer backwards through the finish.
   *
   * What genuinely does not move is whatever is touching the ground. So each
   * frame is aligned to the previous one using only the foot points in
   * contact in BOTH frames, and the correction accumulates. A heel that lifts
   * simply drops out of the set and the toe carries on alone; no point ever
   * has to be assumed stationary while it is visibly moving.
   */
  /*
   * ABSOLUTE alignment to a reference stance, not incremental alignment to
   * the previous frame.
   *
   * The first version accumulated each frame's small correction. That is a
   * random walk: every frame's detection noise is added permanently to a
   * running total, so the whole body drifts. Measured on a clip with 14mm of
   * joint noise, it put 44mm of common-mode error into every joint -- more
   * than the per-joint noise itself -- and being a slow drift rather than
   * jitter, no amount of smoothing downstream could remove it.
   *
   * Aligning each frame independently to a fixed reference stance has no
   * memory, so nothing accumulates. A heel that lifts simply drops out of the
   * set and the remaining points carry the alignment, exactly as before.
   */
  /*
   * The reference stance, averaged over every flat-footed frame rather than
   * read off the anchor frame alone.
   *
   * Same argument as the rotation above: planted feet do not move, so every
   * such frame is another measurement of the same thing, and one frame's
   * worth of detection noise becomes a fixed offset applied to every joint in
   * the clip. Averaging costs a pass over the frames and removes it.
   */
  const reference = new Map<string, Vec3>();
  {
    const sums = new Map<string, { x: number; y: number; z: number; n: number }>();
    for (const index of plantedFrames.indices) {
      const frame = frames[index];
      for (const joint of FOOT_JOINTS) {
        const observed = frame.joints[joint];
        if (!observed) continue;
        const rotated = toWorldAxes(observed.position as Vec3);
        const entry = sums.get(joint) ?? { x: 0, y: 0, z: 0, n: 0 };
        entry.x += rotated[0];
        entry.y += rotated[1];
        entry.z += rotated[2];
        entry.n += 1;
        sums.set(joint, entry);
      }
    }
    for (const [joint, entry] of sums) {
      reference.set(joint, [entry.x / entry.n, entry.y / entry.n, entry.z / entry.n]);
    }

    // No flat-footed frame anywhere -- a clip that starts mid-swing. Fall back
    // to the anchor frame, and `anchorIsStable` already says not to trust it.
    if (reference.size === 0 && anchorFrame) {
      const anchorGround = lowestFootY(anchorFrame, toWorldAxes) ?? 0;
      for (const joint of FOOT_JOINTS) {
        const observed = anchorFrame.joints[joint];
        if (!observed) continue;
        const rotated = toWorldAxes(observed.position as Vec3);
        if (rotated[1] - anchorGround <= CONTACT_TOLERANCE_M) reference.set(joint, rotated);
      }
    }
  }

  let lastGroundY = anchorFrame ? lowestFootY(anchorFrame, toWorldAxes) ?? 0 : 0;
  let lastOffsetX = 0;
  let lastOffsetY = 0;
  let lastOffsetZ = 0;

  interface Staged {
    readonly frame: CameraObservationFrame;
    readonly joints: Partial<Record<string, Vec3>>;
  }

  const staged: Staged[] = frames.map((frame) => {
    const rotated: Partial<Record<string, Vec3>> = {};
    for (const [name, observed] of Object.entries(frame.joints) as [string, ObservedJoint][]) {
      rotated[name] = toWorldAxes(observed.position as Vec3);
    }

    // A frame with no visible foot cannot be pinned on its own evidence. It
    // carries the previous offsets forward rather than snapping to the hips,
    // which would jolt the whole body for one frame and look exactly like a
    // tracking failure.
    const groundY = lowestFootY(frame, toWorldAxes) ?? lastGroundY;
    lastGroundY = groundY;

    let offsetX = lastOffsetX;
    let offsetY = lastOffsetY;
    let offsetZ = lastOffsetZ;

    /*
     * All three axes are aligned the same way: by the MEAN offset of the
     * contact points from their reference positions.
     *
     * Vertically that replaces pinning the lowest foot point to zero, which
     * looks obvious and is a poor estimator. A minimum over noisy values is
     * biased downward and jumps to whichever point happened to be measured
     * low this frame, so the whole body bobbed. A mean over the same points
     * averages the noise down instead of amplifying it.
     */
    const contact = contactPoints(rotated, groundY);
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let shared = 0;
    for (const [joint, position] of contact) {
      const anchored = reference.get(joint);
      if (!anchored) continue;
      sumX += position[0] - anchored[0];
      sumY += position[1] - anchored[1];
      sumZ += position[2] - anchored[2];
      shared += 1;
    }
    if (shared > 0) {
      offsetX = sumX / shared;
      offsetY = sumY / shared;
      offsetZ = sumZ / shared;
      lastOffsetX = offsetX;
      lastOffsetY = offsetY;
      lastOffsetZ = offsetZ;
    }

    const placed: Partial<Record<string, Vec3>> = {};
    for (const [name, position] of Object.entries(rotated) as [string, Vec3][]) {
      placed[name] = [position[0] - offsetX, position[1] - offsetY, position[2] - offsetZ];
    }
    return { frame, joints: placed };
  });

  /*
   * Put the ground at Y = 0, once, for the whole clip.
   *
   * A low percentile rather than the outright minimum: over a few hundred
   * frames the single lowest foot sample is whichever one the detector got
   * most wrong, so using it would sink the golfer by the size of its worst
   * error. Taking the 3rd percentile keeps that out while still landing on
   * genuinely planted feet.
   */
  const footHeights: number[] = [];
  for (const { joints: placed } of staged) {
    for (const joint of FOOT_JOINTS) {
      const position = placed[joint];
      if (position) footHeights.push(position[1]);
    }
  }
  footHeights.sort((a, b) => a - b);
  const groundLevel =
    footHeights.length > 0 ? footHeights[Math.floor(footHeights.length * 0.03)] : 0;

  /*
   * Now put the origin where the anchor frame's stance was, so the world
   * frame is pinned to the golfer rather than to wherever frame zero's
   * accumulated offset happened to land.
   */
  const anchorStaged = staged[choice.index];
  const anchorLeft = anchorStaged?.joints.leftAnkle;
  const anchorRight = anchorStaged?.joints.rightAnkle;
  const originX =
    anchorLeft && anchorRight ? (anchorLeft[0] + anchorRight[0]) / 2 : 0;
  const originZ =
    anchorLeft && anchorRight ? (anchorLeft[2] + anchorRight[2]) / 2 : 0;

  const worldFrames: WorldObservationFrame[] = staged.map(({ frame, joints: placed }) => {
    const joints: Partial<Record<keyof typeof frame.joints, ObservedJoint>> = {};
    for (const [name, observed] of Object.entries(frame.joints) as [
      keyof typeof frame.joints,
      ObservedJoint,
    ][]) {
      const position = placed[name as string];
      if (!position) continue;
      joints[name] = {
        ...observed,
        position: [position[0] - originX, position[1] - groundLevel, position[2] - originZ],
      };
    }

    return {
      space: "world",
      index: frame.index,
      timestampMs: frame.timestampMs,
      detected: frame.detected,
      joints,
      club: frame.club,
    };
  });

  return {
    space: "world",
    frames: worldFrames,
    fps: sequence.fps,
    width: sequence.width,
    height: sequence.height,
    durationMs: sequence.durationMs,
    detector: sequence.detector,
    anchor,
  };
};

/** How much of the sequence the detector actually saw. For the honesty readout. */
export const detectionRate = (sequence: CameraObservationSequence): number =>
  sequence.frames.length === 0
    ? 0
    : clampUnit(
        sequence.frames.filter((frame) => frame.detected).length / sequence.frames.length
      );
