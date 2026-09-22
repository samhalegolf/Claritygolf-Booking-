/**
 * Detector output -> Clarity's vocabulary and axes.
 *
 * THIS IS THE ONLY PLACE THE AXIS CONVERSION HAPPENS. If a body ever renders
 * upside down, mirrored or on its side, the bug is in this file and nowhere
 * else -- which is the entire reason it is one small, heavily tested
 * function rather than a flip scattered across three call sites.
 *
 * MEDIAPIPE'S FRAME              CLARITY'S FRAME
 *   x  image right                 X  image right      (unchanged)
 *   y  DOWN                        Y  UP               (negated)
 *   z  INTO the screen             Z  toward camera    (negated)
 *
 * Both are right-handed. Negating Y alone would flip the handedness and
 * mirror the golfer -- a left-handed swing rendered from a right-handed one,
 * which looks like a plausible swing and is therefore the worst possible
 * failure mode. Negating Z as well restores it.
 *
 * World landmarks are metres with the origin at the hip midpoint. This
 * function does NOT anchor them to the ground or to the stance line; that
 * needs the whole sequence and lives in `anchor.ts`. The result is a
 * CameraObservationFrame, and the type system will not let it be mistaken
 * for a world-space one.
 */

import type { ClarityJoint, Unit } from "../contracts";
import { clampUnit } from "../contracts";
import { JOINT_SOURCES, MP_LANDMARK_COUNT } from "./mediapipe/landmarks";
import type {
  CameraObservationFrame,
  ObservationFrame,
  ObservedJoint,
  RawLandmark,
} from "./observation";

export interface ToCameraFrameOptions {
  /**
   * Below this visibility a landmark is treated as NOT OBSERVED rather than
   * as a low-confidence observation.
   *
   * This is the one genuinely lossy decision in the file, so the default is
   * deliberately permissive. The evidence layer's job is to stay honest about
   * what the detector could see, and a detector reporting 0.2 visibility is
   * saying something -- discarding it here would hide it from the overlay and
   * from the Motion Layer, which is better equipped to weigh it.
   */
  readonly visibilityFloor?: number;
  /** Same, for presence: the detector's belief the part is in the image at all. */
  readonly presenceFloor?: number;
}

/**
 * Exported so the overlay can say, per landmark, whether Clarity kept it.
 * The floors are the one lossy decision in this file, and a reading that
 * fell under them should be visibly discarded rather than quietly absent.
 */
export const OBSERVATION_FLOORS = {
  visibilityFloor: 0.1,
  presenceFloor: 0.1,
} as const;

const DEFAULTS = OBSERVATION_FLOORS;

/** MediaPipe world landmarks -> Clarity axes. The whole conversion, in one line. */
export const toClarityAxes = (landmark: RawLandmark): [number, number, number] => [
  landmark.x,
  -landmark.y,
  -landmark.z,
];

const isUsable = (
  landmark: RawLandmark | undefined,
  visibilityFloor: number,
  presenceFloor: number
): landmark is RawLandmark => {
  if (!landmark) return false;
  if (!Number.isFinite(landmark.x + landmark.y + landmark.z)) return false;
  return landmark.visibility >= visibilityFloor && landmark.presence >= presenceFloor;
};

export const toCameraFrame = (
  raw: ObservationFrame,
  options: ToCameraFrameOptions = {}
): CameraObservationFrame => {
  const visibilityFloor = options.visibilityFloor ?? DEFAULTS.visibilityFloor;
  const presenceFloor = options.presenceFloor ?? DEFAULTS.presenceFloor;

  const joints: Partial<Record<ClarityJoint, ObservedJoint>> = {};

  // No world landmarks means no metric position, and a metric position is
  // what the 3D reconstruction is built on. An empty joint map is the honest
  // answer; inventing depth from the image landmarks would not be.
  const world = raw.world;
  const image = raw.image;

  if (raw.detected && world && world.length >= MP_LANDMARK_COUNT) {
    for (const source of JOINT_SOURCES) {
      const landmarks = source.from.map((index) => world[index]);
      const imageLandmarks = image ? source.from.map((index) => image[index]) : [];

      // Every contributing landmark must be usable. A midpoint built from one
      // good and one missing landmark is not a midpoint, it is a guess sitting
      // half a shoulder-width from the truth.
      if (!landmarks.every((entry) => isUsable(entry, visibilityFloor, presenceFloor))) {
        continue;
      }

      const usable = landmarks as RawLandmark[];
      const position = averageAxes(usable);

      joints[source.joint] = {
        position,
        image: averageImage(imageLandmarks, usable),
        // A derived joint is only as trustworthy as its worst input.
        visibility: clampUnit(Math.min(...usable.map((entry) => entry.visibility))),
        presence: clampUnit(Math.min(...usable.map((entry) => entry.presence))),
        sourceCount: usable.length,
      };
    }
  }

  return {
    space: "camera",
    index: raw.index,
    timestampMs: raw.timestampMs,
    detected: raw.detected,
    joints,
    club: raw.club,
  };
};

const averageAxes = (landmarks: readonly RawLandmark[]): [number, number, number] => {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const landmark of landmarks) {
    const converted = toClarityAxes(landmark);
    x += converted[0];
    y += converted[1];
    z += converted[2];
  }
  const count = landmarks.length;
  return [x / count, y / count, z / count];
};

/**
 * The image position, for the video overlay.
 *
 * Image coordinates keep MediaPipe's convention -- normalised 0..1, origin
 * top-left, Y DOWN -- because that is what a canvas over a video wants. The
 * overlay draws evidence, so it uses the evidence's own coordinates.
 */
const averageImage = (
  imageLandmarks: readonly (RawLandmark | undefined)[],
  fallback: readonly RawLandmark[]
): [number, number] => {
  const usable = imageLandmarks.filter((entry): entry is RawLandmark => Boolean(entry));
  const source = usable.length > 0 ? usable : fallback;
  let x = 0;
  let y = 0;
  for (const landmark of source) {
    x += landmark.x;
    y += landmark.y;
  }
  return [x / source.length, y / source.length];
};

/** How much of the body this frame actually saw. For the overlay's honesty readout. */
export const observedFraction = (frame: CameraObservationFrame): Unit =>
  clampUnit(Object.keys(frame.joints).length / JOINT_SOURCES.length);
