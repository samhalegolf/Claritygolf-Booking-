/**
 * MediaPipe Pose landmark indices, and how they become Clarity joints.
 *
 * THIS FILE IS THE ONLY PLACE IN THE LAB THAT KNOWS A LANDMARK INDEX EXISTS.
 * Everything downstream speaks Clarity joint names. That is the point of the
 * whole boundary: swapping detector, or adding a second one, is a change here
 * and nowhere else.
 *
 * MediaPipe's "left" and "right" are the SUBJECT's, not the image's. A golfer
 * facing away from the camera still has their anatomical left shoulder
 * reported as `LEFT_SHOULDER`. That is what makes the world frame's
 * "+X from the left foot toward the right foot" well-defined without knowing
 * which way the camera was pointing.
 */

import type { ClarityJoint } from "../../contracts";

/** The 33 BlazePose landmarks, named. */
export const MP = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export const MP_LANDMARK_COUNT = 33;

/**
 * How a Clarity joint is built from landmarks.
 *
 * A joint is either one landmark or the midpoint of several. Nothing more
 * elaborate: this stage RELABELS, it does not reconstruct. Inference belongs
 * to the Motion Layer, where it can be recorded in provenance and paid for in
 * confidence. Doing any of it here would hide it.
 */
export interface JointSource {
  readonly joint: ClarityJoint;
  readonly from: readonly number[];
  /** Why these landmarks, when it is not obvious. */
  readonly note?: string;
}

export const JOINT_SOURCES: readonly JointSource[] = [
  {
    joint: "head",
    from: [MP.LEFT_EAR, MP.RIGHT_EAR],
    note:
      "Between the ears rather than the nose: the cranium's centre barely moves " +
      "when the face turns, and the nose swings several centimetres.",
  },
  {
    joint: "neck",
    from: [MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER],
    note: "BlazePose has no neck landmark. The base of the neck is the shoulder midpoint.",
  },
  { joint: "leftShoulder", from: [MP.LEFT_SHOULDER] },
  { joint: "rightShoulder", from: [MP.RIGHT_SHOULDER] },
  { joint: "leftElbow", from: [MP.LEFT_ELBOW] },
  { joint: "rightElbow", from: [MP.RIGHT_ELBOW] },
  { joint: "leftWrist", from: [MP.LEFT_WRIST] },
  { joint: "rightWrist", from: [MP.RIGHT_WRIST] },
  {
    joint: "leftHand",
    from: [MP.LEFT_INDEX, MP.LEFT_PINKY],
    note:
      "Index and pinky knuckles, not the thumb: on a golf grip the thumb runs " +
      "down the shaft and sits well away from the centre of the hand.",
  },
  { joint: "rightHand", from: [MP.RIGHT_INDEX, MP.RIGHT_PINKY] },
  { joint: "leftHip", from: [MP.LEFT_HIP] },
  { joint: "rightHip", from: [MP.RIGHT_HIP] },
  { joint: "leftKnee", from: [MP.LEFT_KNEE] },
  { joint: "rightKnee", from: [MP.RIGHT_KNEE] },
  { joint: "leftAnkle", from: [MP.LEFT_ANKLE] },
  { joint: "rightAnkle", from: [MP.RIGHT_ANKLE] },
  { joint: "leftHeel", from: [MP.LEFT_HEEL] },
  { joint: "rightHeel", from: [MP.RIGHT_HEEL] },
  { joint: "leftToe", from: [MP.LEFT_FOOT_INDEX] },
  { joint: "rightToe", from: [MP.RIGHT_FOOT_INDEX] },
];

/** Landmarks that contribute to nothing. Kept explicit so the omission is deliberate. */
export const UNUSED_LANDMARKS: readonly number[] = [
  MP.NOSE,
  MP.LEFT_EYE_INNER,
  MP.LEFT_EYE,
  MP.LEFT_EYE_OUTER,
  MP.RIGHT_EYE_INNER,
  MP.RIGHT_EYE,
  MP.RIGHT_EYE_OUTER,
  MP.MOUTH_LEFT,
  MP.MOUTH_RIGHT,
  MP.LEFT_THUMB,
  MP.RIGHT_THUMB,
];
