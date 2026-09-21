/**
 * The golfer as something solid, for the one question geometry cannot answer.
 *
 * THE AMBIGUITY THIS EXISTS TO BREAK
 *
 * A clubhead on a viewing line, constrained to a sphere around the hands,
 * has TWO solutions -- the club pointing toward the camera or away from it.
 * Continuity picks consistently between them, but it cannot pick correctly,
 * because a swing and its mirror image about the viewing plane produce
 * EXACTLY the same images. This is not a weakness of the affine camera; a
 * perspective camera has the same two intersections. One viewpoint plus one
 * sphere genuinely does not determine depth.
 *
 * Measured on a face-on clip, choosing wrongly put every frame out by 181mm
 * -- precisely twice the club's depth -- and on a clip shot down the line, by
 * 1.6 metres.
 *
 * WHAT BREAKS IT
 *
 * The golfer is solid. At address the club runs down and FORWARD to the ball;
 * its mirror runs down and backward, through the golfer's own legs. That is
 * not a statement about technique -- it is the plan's "physical objects do
 * not teleport" applied to the other obvious fact about physical objects,
 * which is that two of them cannot occupy the same place.
 *
 * So both whole trajectories are scored by how far the clubhead spends inside
 * the body, and the one that spends less wins. Whole trajectories, not
 * frames: the choice is global, so the evidence should be too, and a single
 * ambiguous frame cannot overturn a swing's worth of it.
 */

import type { ClarityJoint, Vec3 } from "../../contracts";
import { dot, sub } from "../../contracts";

/** A rounded cylinder. Cheap to test a point against, and close enough to a limb. */
export interface Capsule {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radiusM: number;
}

/**
 * Body parts a clubhead has no business being inside.
 *
 * Radii are generous rather than anatomical. The test is not "did the club
 * grazes the shirt" -- it is "is this trajectory the one that goes through
 * the golfer", and for that a fat approximation is both sufficient and more
 * robust than a tight one.
 *
 * The ARMS are deliberately absent. The club genuinely passes close to the
 * lead arm at the top of many swings, and counting that as a collision would
 * penalise the correct trajectory.
 */
export const bodyObstacles = (
  joints: Readonly<Record<ClarityJoint, Vec3>>,
  heightM: number
): Capsule[] => {
  const mid = (a: Vec3, b: Vec3): Vec3 => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  ];
  const scaleOf = heightM / 1.8;

  return [
    // Torso, pelvis to neck.
    {
      a: mid(joints.leftHip, joints.rightHip),
      b: mid(joints.leftShoulder, joints.rightShoulder),
      radiusM: 0.17 * scaleOf,
    },
    // Head.
    { a: joints.head, b: joints.neck, radiusM: 0.11 * scaleOf },
    // Legs.
    { a: joints.leftHip, b: joints.leftKnee, radiusM: 0.09 * scaleOf },
    { a: joints.leftKnee, b: joints.leftAnkle, radiusM: 0.07 * scaleOf },
    { a: joints.rightHip, b: joints.rightKnee, radiusM: 0.09 * scaleOf },
    { a: joints.rightKnee, b: joints.rightAnkle, radiusM: 0.07 * scaleOf },
  ];
};

/** Metres a point lies inside a capsule. Zero when outside. */
export const penetration = (point: Vec3, capsule: Capsule): number => {
  const axis = sub(capsule.b, capsule.a);
  const lengthSq = dot(axis, axis);
  const toPoint = sub(point, capsule.a);

  // Clamped so the capsule's rounded ends are tested, not an infinite cylinder.
  const t = lengthSq < 1e-12 ? 0 : Math.min(1, Math.max(0, dot(toPoint, axis) / lengthSq));
  const closest: Vec3 = [
    capsule.a[0] + axis[0] * t,
    capsule.a[1] + axis[1] * t,
    capsule.a[2] + axis[2] * t,
  ];
  const distance = Math.hypot(
    point[0] - closest[0],
    point[1] - closest[1],
    point[2] - closest[2]
  );
  return Math.max(0, capsule.radiusM - distance);
};

/** Deepest penetration into any obstacle. */
export const penetrationDepth = (
  point: Vec3,
  obstacles: readonly Capsule[]
): number => {
  let worst = 0;
  for (const capsule of obstacles) worst = Math.max(worst, penetration(point, capsule));
  return worst;
};

/**
 * Also penalise the club passing UNDER the ground.
 *
 * With a generous tolerance, because the club legitimately reaches the turf:
 * a clubhead at impact sits a centimetre below Y = 0 and is meant to. Scoring
 * that as impossible penalised the CORRECT trajectory, and on one camera
 * angle that alone was enough to flip the whole swing.
 *
 * The signal wanted HERE is a club half a metre underground. The finer
 * judgement -- whether the club's lowest point reaches the ground at all --
 * is made once per clip in `clubModel.ts`, where a whole-clip statistic can
 * afford a much tighter band than any per-frame test could.
 */
export const GROUND_TOLERANCE_M = 0.08;

export const belowGround = (point: Vec3): number =>
  Math.max(0, -(point[1] + GROUND_TOLERANCE_M));

/**
 * How far the club would have to move to become anatomically possible.
 *
 * THE CUE THAT ACTUALLY SETTLES THE DEPTH AMBIGUITY
 *
 * The body's solidity turned out to be nearly useless for this: the mirrored
 * clubhead is still about a club's length from the hands, so it misses the
 * golfer just as cleanly as the real one does. Measured across five camera
 * angles, it produced a tie on four.
 *
 * The wrist does not. A club is held in the hands, so the angle between the
 * shaft and the forearm IS the wrist angle, and a wrist has a limited range:
 * fully cocked puts the shaft at roughly a right angle to the forearm, and
 * nothing puts it further. On a real swing that angle stayed between 109 and
 * 174 degrees at every camera angle -- unsurprising, since it is a property
 * of the golfer and not of the camera. The mirrored trajectories fell to
 * between 49 and 84 degrees, which would fold the club back along the arm.
 *
 * Returned in metres, as the arc the clubhead would have to travel to reach a
 * possible angle, so it can be added to the occupancy cost without an
 * arbitrary weight between degrees and distance.
 */
export const MIN_SHAFT_TO_FOREARM_RAD = (80 * Math.PI) / 180;

export const anatomicalViolation = (
  shaft: Vec3,
  forearms: readonly Vec3[],
  shaftLengthM: number
): number => {
  let best = 0;
  let found = false;

  for (const forearm of forearms) {
    const shaftLength = Math.hypot(...shaft);
    const armLength = Math.hypot(...forearm);
    if (shaftLength < 1e-6 || armLength < 1e-6) continue;

    const cosine = dot(shaft, forearm) / (shaftLength * armLength);
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
    // The MOST EXTENDED arm decides. If the club really were folded back
    // along the arms, both would show a tight angle; one arm being folded is
    // just a golfer with a bent trail elbow.
    if (!found || angle > best) {
      best = angle;
      found = true;
    }
  }

  if (!found) return 0;
  return Math.max(0, MIN_SHAFT_TO_FOREARM_RAD - best) * shaftLengthM;
};
