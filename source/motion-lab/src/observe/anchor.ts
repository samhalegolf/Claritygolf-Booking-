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
import { clampUnit, distance, normalise, projectToGround } from "../contracts";
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

/** Rotate about Y. Kept local because the angle is derived, never passed around. */
const rotateY = (point: Vec3, cos: number, sin: number): Vec3 => [
  point[0] * cos + point[2] * sin,
  point[1],
  -point[0] * sin + point[2] * cos,
];

/** Lowest foot point in a frame, or null when no foot was seen. */
const lowestFootY = (frame: CameraObservationFrame, cos: number, sin: number): number | null => {
  let lowest: number | null = null;
  for (const joint of FOOT_JOINTS) {
    const observed = frame.joints[joint];
    if (!observed) continue;
    const rotated = rotateY(observed.position as Vec3, cos, sin);
    if (lowest === null || rotated[1] < lowest) lowest = rotated[1];
  }
  return lowest;
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
  const leftAnkle = anchorFrame?.joints.leftAnkle;
  const rightAnkle = anchorFrame?.joints.rightAnkle;

  let cos = 1;
  let sin = 0;
  let stanceWidthM = 0;

  if (leftAnkle && rightAnkle) {
    const across = projectToGround([
      rightAnkle.position[0] - leftAnkle.position[0],
      0,
      rightAnkle.position[2] - leftAnkle.position[2],
    ]);
    stanceWidthM = distance([0, 0, 0], across);
    if (stanceWidthM > 1e-4) {
      const unit = normalise(across);
      // The rotation that brings `unit` onto +X. Derived from the measured
      // stance, so a golfer standing at any angle to the camera ends up in the
      // same frame of reference.
      // Rotating (a, 0, b) onto (1, 0, 0) about Y needs cos = a, sin = b.
      // The sign here is invisible to any test where the golfer happens to
      // stand square to the camera, because then b is zero and both signs
      // agree -- which is why the round trip is also run at 37 degrees.
      cos = unit[0];
      sin = unit[2];
    }
  }

  const anchor: WorldFrameAnchor = {
    anchorFrameIndex: choice.index,
    stanceWidthM,
    anchorIsStable: choice.stable && stanceWidthM > 1e-4,
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
  const CONTACT_TOLERANCE_M = 0.03;

  const contactPoints = (rotated: Partial<Record<string, Vec3>>, groundY: number) => {
    const contact = new Map<string, Vec3>();
    for (const joint of FOOT_JOINTS) {
      const position = rotated[joint];
      if (!position) continue;
      if (position[1] - groundY <= CONTACT_TOLERANCE_M) contact.set(joint, position);
    }
    return contact;
  };

  let offsetX = 0;
  let offsetZ = 0;
  let lastGroundY = anchorFrame ? lowestFootY(anchorFrame, cos, sin) ?? 0 : 0;
  let previousContact: Map<string, Vec3> | null = null;

  interface Staged {
    readonly frame: CameraObservationFrame;
    readonly joints: Partial<Record<string, Vec3>>;
  }

  const staged: Staged[] = frames.map((frame) => {
    const rotated: Partial<Record<string, Vec3>> = {};
    for (const [name, observed] of Object.entries(frame.joints) as [string, ObservedJoint][]) {
      rotated[name] = rotateY(observed.position as Vec3, cos, sin);
    }

    // A frame with no visible foot cannot be pinned on its own evidence. It
    // carries the previous offsets forward rather than snapping to the hips,
    // which would jolt the whole body for one frame and look exactly like a
    // tracking failure.
    const groundY = lowestFootY(frame, cos, sin) ?? lastGroundY;
    lastGroundY = groundY;

    const contact = contactPoints(rotated, groundY);
    if (previousContact) {
      let sumX = 0;
      let sumZ = 0;
      let shared = 0;
      for (const [joint, position] of contact) {
        const before = previousContact.get(joint);
        if (!before) continue;
        sumX += position[0] - before[0];
        sumZ += position[2] - before[2];
        shared += 1;
      }
      if (shared > 0) {
        offsetX += sumX / shared;
        offsetZ += sumZ / shared;
      }
    }
    if (contact.size > 0) previousContact = contact;

    const placed: Partial<Record<string, Vec3>> = {};
    for (const [name, position] of Object.entries(rotated) as [string, Vec3][]) {
      placed[name] = [position[0] - offsetX, position[1] - groundY, position[2] - offsetZ];
    }
    return { frame, joints: placed };
  });

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
        position: [position[0] - originX, position[1], position[2] - originZ],
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
