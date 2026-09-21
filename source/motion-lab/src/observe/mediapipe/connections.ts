/**
 * MediaPipe's own skeleton, for the raw overlay.
 *
 * Deliberately MediaPipe's topology, not Clarity's. The overlay's job is to
 * show what the DETECTOR saw, in the detector's own terms -- so it draws the
 * detector's connections, including the face and the thumbs that Clarity
 * throws away. Drawing Clarity's skeleton here would already be a step of
 * interpretation, and the whole point of this layer is that it has not taken
 * one yet.
 */

import { MP } from "./landmarks";

export const MP_CONNECTIONS: readonly (readonly [number, number])[] = [
  // Face
  [MP.LEFT_EAR, MP.LEFT_EYE_OUTER],
  [MP.LEFT_EYE_OUTER, MP.LEFT_EYE],
  [MP.LEFT_EYE, MP.LEFT_EYE_INNER],
  [MP.LEFT_EYE_INNER, MP.NOSE],
  [MP.NOSE, MP.RIGHT_EYE_INNER],
  [MP.RIGHT_EYE_INNER, MP.RIGHT_EYE],
  [MP.RIGHT_EYE, MP.RIGHT_EYE_OUTER],
  [MP.RIGHT_EYE_OUTER, MP.RIGHT_EAR],
  [MP.MOUTH_LEFT, MP.MOUTH_RIGHT],

  // Torso
  [MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER],
  [MP.LEFT_SHOULDER, MP.LEFT_HIP],
  [MP.RIGHT_SHOULDER, MP.RIGHT_HIP],
  [MP.LEFT_HIP, MP.RIGHT_HIP],

  // Arms
  [MP.LEFT_SHOULDER, MP.LEFT_ELBOW],
  [MP.LEFT_ELBOW, MP.LEFT_WRIST],
  [MP.LEFT_WRIST, MP.LEFT_THUMB],
  [MP.LEFT_WRIST, MP.LEFT_INDEX],
  [MP.LEFT_WRIST, MP.LEFT_PINKY],
  [MP.LEFT_INDEX, MP.LEFT_PINKY],
  [MP.RIGHT_SHOULDER, MP.RIGHT_ELBOW],
  [MP.RIGHT_ELBOW, MP.RIGHT_WRIST],
  [MP.RIGHT_WRIST, MP.RIGHT_THUMB],
  [MP.RIGHT_WRIST, MP.RIGHT_INDEX],
  [MP.RIGHT_WRIST, MP.RIGHT_PINKY],
  [MP.RIGHT_INDEX, MP.RIGHT_PINKY],

  // Legs
  [MP.LEFT_HIP, MP.LEFT_KNEE],
  [MP.LEFT_KNEE, MP.LEFT_ANKLE],
  [MP.LEFT_ANKLE, MP.LEFT_HEEL],
  [MP.LEFT_HEEL, MP.LEFT_FOOT_INDEX],
  [MP.LEFT_ANKLE, MP.LEFT_FOOT_INDEX],
  [MP.RIGHT_HIP, MP.RIGHT_KNEE],
  [MP.RIGHT_KNEE, MP.RIGHT_ANKLE],
  [MP.RIGHT_ANKLE, MP.RIGHT_HEEL],
  [MP.RIGHT_HEEL, MP.RIGHT_FOOT_INDEX],
  [MP.RIGHT_ANKLE, MP.RIGHT_FOOT_INDEX],
];
