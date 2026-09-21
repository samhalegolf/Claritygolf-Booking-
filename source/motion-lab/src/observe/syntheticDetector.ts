/**
 * A detector that makes up MediaPipe output from a known body.
 *
 * WHY THIS EARNS ITS PLACE
 *
 * It closes the loop. Take a body whose true position is known, express it in
 * the detector's own awkward convention -- hip-centred, Y down, Z into the
 * screen, 33 landmarks including several Clarity does not use -- push it
 * through the real observation pipeline, and check what comes out is the body
 * we started with.
 *
 * That is a test no real video can provide, because real video has no ground
 * truth. It catches the entire class of bug where a mirrored or rotated body
 * still looks like a plausible golfer, which is the worst kind: it does not
 * throw, and it does not look wrong until something much later disagrees.
 *
 * It also means the Motion Layer can be built and graded against known
 * answers before a single frame of real footage exists.
 *
 * This is a FIXTURE. Nothing it does is reconstruction, and the Motion Layer
 * must never import it.
 */

import type { ClarityFrame, ClarityJoint, Vec3 } from "../contracts";
import { add, lerpVec, normalise, scale, sub } from "../contracts";
import { MP, MP_LANDMARK_COUNT } from "./mediapipe/landmarks";
import type { ObservationFrame, RawLandmark } from "./observation";

export interface SyntheticDetectorOptions {
  /**
   * Yaw of the golfer relative to the camera, degrees. Non-zero exercises the
   * anchoring rotation, which is otherwise the identity and therefore
   * untested.
   */
  readonly cameraYawDeg?: number;
  /**
   * Pitch of the camera, degrees, as a tripod on a slope gives. Positive tips
   * the lens down.
   *
   * The tilt the stance line cannot see: it rotates about that same line, so
   * the anatomical levelling passes it straight through. What catches it is
   * the falling-over boundary -- see `motion/reconstruct/levelled`.
   */
  readonly cameraPitchDeg?: number;
  /** Joints the detector cannot see, by frame window. */
  readonly dropouts?: readonly {
    readonly joint: ClarityJoint;
    readonly startFrame: number;
    readonly length: number;
  }[];
  /** Frames where the detector finds nothing at all. */
  readonly blindFrames?: readonly number[];
  /** Visibility reported for a seen landmark. */
  readonly visibility?: number;
  /** Image size, for the normalised image coordinates. */
  readonly width?: number;
  readonly height?: number;
  /** Frames where the clubhead is not found. */
  readonly clubLostFrom?: number;
  /** Jitter on the detected clubhead, in normalised image units. */
  readonly clubNoise?: number;
  readonly clubConfidence?: number;
}

const DEG = Math.PI / 180;

const rotateY = (point: Vec3, radians: number): Vec3 => {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [point[0] * cos - point[2] * sin, point[1], point[0] * sin + point[2] * cos];
};

/**
 * Clarity world -> MediaPipe world. The exact inverse of `toClarityAxes`,
 * plus the hip re-centring the detector does and the camera yaw.
 */
const toMediaPipeAxes = (
  point: Vec3,
  hipCentre: Vec3,
  yawRad: number,
  pitchRad: number
): Vec3 => {
  const relative = rotateY(sub(point, hipCentre), yawRad);
  const mp: Vec3 = [relative[0], -relative[1], -relative[2]];
  if (pitchRad === 0) return mp;
  /*
   * The pitch goes in HERE, in the detector's own axes, because that is where
   * a real one lands: a detector's world landmarks are aligned to the image,
   * so a lens tilted down reports a body tilted back and calls it upright.
   *
   * The image landmarks are projected from these, so they inherit it too and
   * the two stay consistent -- which matters, because the club's camera fit
   * pairs the two together.
   */
  const cos = Math.cos(pitchRad);
  const sin = Math.sin(pitchRad);
  return [mp[0], mp[1] * cos - mp[2] * sin, mp[1] * sin + mp[2] * cos];
};

const landmark = (position: Vec3, visibility: number): RawLandmark => ({
  x: position[0],
  y: position[1],
  z: position[2],
  visibility,
  presence: visibility,
});

const MISSING: RawLandmark = { x: 0, y: 0, z: 0, visibility: 0, presence: 0 };

/**
 * Landmarks Clarity derives rather than reads, rebuilt so the derivation has
 * something to work on.
 *
 * The ears sit either side of the head marker and the knuckles either side of
 * the hand marker, at plausible spacings. Their midpoints are therefore the
 * Clarity joint we started from, which is exactly what the mapping expects to
 * find.
 */
const spreadPair = (centre: Vec3, axis: Vec3, halfWidth: number): [Vec3, Vec3] => {
  const offset = scale(normalise(axis), halfWidth);
  return [sub(centre, offset), add(centre, offset)];
};

export const detectFromClarityFrame = (
  frame: ClarityFrame,
  options: SyntheticDetectorOptions = {}
): ObservationFrame => {
  const yawRad = (options.cameraYawDeg ?? 0) * DEG;
  const pitchRad = (options.cameraPitchDeg ?? 0) * DEG;
  const visibility = options.visibility ?? 0.92;
  const joints = frame.body.joints;

  if ((options.blindFrames ?? []).includes(frame.index)) {
    return {
      index: frame.index,
      timestampMs: frame.timestampMs,
      detected: false,
      image: null,
      world: null,
      club: null,
    };
  }

  const hipCentre = lerpVec(joints.leftHip, joints.rightHip, 0.5);
  const isHidden = (joint: ClarityJoint) =>
    (options.dropouts ?? []).some(
      (entry) =>
        entry.joint === joint &&
        frame.index >= entry.startFrame &&
        frame.index < entry.startFrame + entry.length
    );

  const world: RawLandmark[] = new Array(MP_LANDMARK_COUNT).fill(MISSING);

  const place = (index: number, position: Vec3, hidden: boolean) => {
    world[index] = hidden
      ? MISSING
      : landmark(toMediaPipeAxes(position, hipCentre, yawRad, pitchRad), visibility);
  };

  // The stance axis is what the ears and knuckles are spread along. Derived
  // from the body rather than assumed, so it stays right at any camera yaw.
  const across = sub(joints.rightShoulder, joints.leftShoulder);

  const [leftEar, rightEar] = spreadPair(joints.head, across, 0.075);
  place(MP.LEFT_EAR, leftEar, isHidden("head"));
  place(MP.RIGHT_EAR, rightEar, isHidden("head"));
  // The nose is not used by the mapping, but a detector would report it and
  // the overlay draws whatever it is given.
  place(MP.NOSE, add(joints.head, scale(normalise(sub(joints.head, joints.neck)), 0.02)), isHidden("head"));

  place(MP.LEFT_SHOULDER, joints.leftShoulder, isHidden("leftShoulder"));
  place(MP.RIGHT_SHOULDER, joints.rightShoulder, isHidden("rightShoulder"));
  place(MP.LEFT_ELBOW, joints.leftElbow, isHidden("leftElbow"));
  place(MP.RIGHT_ELBOW, joints.rightElbow, isHidden("rightElbow"));
  place(MP.LEFT_WRIST, joints.leftWrist, isHidden("leftWrist"));
  place(MP.RIGHT_WRIST, joints.rightWrist, isHidden("rightWrist"));

  const handAxis = sub(joints.rightHand, joints.leftHand);
  const [leftIndex, leftPinky] = spreadPair(joints.leftHand, handAxis, 0.028);
  place(MP.LEFT_INDEX, leftIndex, isHidden("leftHand"));
  place(MP.LEFT_PINKY, leftPinky, isHidden("leftHand"));
  const [rightIndex, rightPinky] = spreadPair(joints.rightHand, handAxis, 0.028);
  place(MP.RIGHT_INDEX, rightIndex, isHidden("rightHand"));
  place(MP.RIGHT_PINKY, rightPinky, isHidden("rightHand"));

  place(MP.LEFT_HIP, joints.leftHip, isHidden("leftHip"));
  place(MP.RIGHT_HIP, joints.rightHip, isHidden("rightHip"));
  place(MP.LEFT_KNEE, joints.leftKnee, isHidden("leftKnee"));
  place(MP.RIGHT_KNEE, joints.rightKnee, isHidden("rightKnee"));
  place(MP.LEFT_ANKLE, joints.leftAnkle, isHidden("leftAnkle"));
  place(MP.RIGHT_ANKLE, joints.rightAnkle, isHidden("rightAnkle"));
  place(MP.LEFT_HEEL, joints.leftHeel, isHidden("leftHeel"));
  place(MP.RIGHT_HEEL, joints.rightHeel, isHidden("rightHeel"));
  place(MP.LEFT_FOOT_INDEX, joints.leftToe, isHidden("leftToe"));
  place(MP.RIGHT_FOOT_INDEX, joints.rightToe, isHidden("rightToe"));

  const image = toImageLandmarks(world);

  /*
   * The clubhead, projected the same way the body landmarks are.
   *
   * A detector sees the club in the IMAGE and knows nothing about its depth,
   * so that is all this reports: two normalised coordinates and a confidence.
   * Recovering where the club actually was in 3D is the Motion Layer's
   * problem, and handing it anything more here would be cheating on the test.
   */
  const clubLost =
    options.clubLostFrom != null && frame.index >= options.clubLostFrom;
  const club =
    frame.club && !clubLost
      ? clubObservation(frame.club.head, hipCentre, yawRad, pitchRad, options)
      : null;

  return {
    index: frame.index,
    timestampMs: frame.timestampMs,
    detected: true,
    image,
    world,
    club,
  };
};

const clubObservation = (
  head: Vec3,
  hipCentre: Vec3,
  yawRad: number,
  // The club sees the same camera the body does. Leaving the pitch out here
  // would put the clubhead in a different world from the hands holding it.
  pitchRad: number,
  options: SyntheticDetectorOptions
): ObservationFrame["club"] => {
  const converted = toMediaPipeAxes(head, hipCentre, yawRad, pitchRad);
  const projected = toImageLandmarks([landmark(converted, 1)])[0];
  const noise = options.clubNoise ?? 0;

  // Deterministic, from the position itself: a fixture that flakes is worse
  // than one that is slightly unrealistic.
  const wobble = (seed: number) =>
    noise === 0 ? 0 : (((Math.sin(seed * 12.9898) * 43758.5453) % 1) * 2 - 1) * noise;

  return {
    imageX: projected.x + wobble(converted[0] + 1),
    imageY: projected.y + wobble(converted[1] + 2),
    imageRadius: 0.018,
    confidence: options.clubConfidence ?? 0.82,
  };
};

/**
 * A rough normalised image projection of the world landmarks.
 *
 * Weakly perspective and not calibrated to anything -- the overlay only needs
 * somewhere plausible to draw, and a fixture that pretended to model a real
 * lens would be claiming an accuracy it does not have.
 */
const toImageLandmarks = (world: readonly RawLandmark[]): RawLandmark[] =>
  world.map((entry) => {
    if (entry.visibility <= 0) return MISSING;
    // MediaPipe world space here: Y already points down.
    const depth = 3.5 + entry.z;
    const scaleFactor = 1.6 / Math.max(0.5, depth);
    return {
      x: 0.5 + entry.x * scaleFactor,
      y: 0.5 + entry.y * scaleFactor,
      z: entry.z,
      visibility: entry.visibility,
      presence: entry.presence,
    };
  });

/** Run a whole ClaritySequence through the fake detector. */
export const detectFromClarityFrames = (
  frames: readonly ClarityFrame[],
  options: SyntheticDetectorOptions = {}
): ObservationFrame[] => frames.map((frame) => detectFromClarityFrame(frame, options));
