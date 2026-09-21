/**
 * Telling the clubhead detector where to look, from the pose.
 *
 * This is the plan's line in practice: golf knowledge may be used to FIND the
 * relevant things, but not to decide how they moved. Knowing that a clubhead
 * is on the end of a club held in the hands, and therefore somewhere in an
 * annulus around them, is finding. It says nothing about where in that
 * annulus the club went or how it got there.
 *
 * Everything is scaled off the body in the picture, so it works at any
 * distance and any resolution without being told either.
 */

import { MP } from "../mediapipe/landmarks";
import type { ObservationFrame, RawLandmark } from "../observation";
import type { ClubheadHint } from "./clubheadDetector";

/** Below this a landmark is too doubtful to define a search region. */
const MIN_VISIBILITY = 0.4;

const midpoint = (
  a: RawLandmark | undefined,
  b: RawLandmark | undefined
): [number, number] | null => {
  if (!a || !b) return null;
  if (a.visibility < MIN_VISIBILITY || b.visibility < MIN_VISIBILITY) return null;
  return [(a.x + b.x) / 2, (a.y + b.y) / 2];
};

/**
 * Build a search hint, or null when the body is too poorly seen to bound one.
 *
 * Returning null is the right answer surprisingly often -- a frame where the
 * golfer is half out of shot cannot say where the club is, and searching the
 * whole picture would find whatever moved most.
 */
export const buildClubheadHint = (frame: ObservationFrame): ClubheadHint | null => {
  const image = frame.image;
  if (!frame.detected || !image) return null;

  // The hands as a detector sees them: the knuckles of both hands together.
  const leftHand = midpoint(image[MP.LEFT_INDEX], image[MP.LEFT_PINKY]);
  const rightHand = midpoint(image[MP.RIGHT_INDEX], image[MP.RIGHT_PINKY]);
  const hands =
    leftHand && rightHand
      ? ([(leftHand[0] + rightHand[0]) / 2, (leftHand[1] + rightHand[1]) / 2] as [
          number,
          number,
        ])
      : (leftHand ?? rightHand);
  if (!hands) return null;

  const shoulders = midpoint(image[MP.LEFT_SHOULDER], image[MP.RIGHT_SHOULDER]);
  const ankles = midpoint(image[MP.LEFT_ANKLE], image[MP.RIGHT_ANKLE]);
  if (!shoulders || !ankles) return null;

  /*
   * The body's own scale, in image units: shoulders to ankles.
   *
   * For a standing adult that span is close to three quarters of standing
   * height, and a club is a bit over half of standing height. The bounds
   * below are deliberately loose around that -- the point is to exclude the
   * far side of the car park, not to pin the club down. Pinning it down is
   * the club model's job, and it has geometry to do it with.
   */
  const bodyScale = Math.hypot(shoulders[0] - ankles[0], shoulders[1] - ankles[1]);
  if (bodyScale < 1e-4) return null;

  const bodyPoints: [number, number][] = [];
  for (const index of [
    MP.NOSE, MP.LEFT_EAR, MP.RIGHT_EAR,
    MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER,
    MP.LEFT_ELBOW, MP.RIGHT_ELBOW,
    MP.LEFT_HIP, MP.RIGHT_HIP,
    MP.LEFT_KNEE, MP.RIGHT_KNEE,
    MP.LEFT_ANKLE, MP.RIGHT_ANKLE,
    MP.LEFT_HEEL, MP.RIGHT_HEEL,
    MP.LEFT_FOOT_INDEX, MP.RIGHT_FOOT_INDEX,
  ]) {
    const landmark = image[index];
    if (landmark && landmark.visibility >= MIN_VISIBILITY) {
      bodyPoints.push([landmark.x, landmark.y]);
    }
  }

  return {
    hands,
    bodyPoints,
    /*
     * The mask deliberately does NOT cover the wrists or hands. Near impact
     * the clubhead passes within a few centimetres of them, and masking there
     * would blind the detector at the one moment everybody wants to look at.
     */
    bodyMaskRadius: bodyScale * 0.14,
    minReach: bodyScale * 0.2,
    maxReach: bodyScale * 1.05,
  };
};
