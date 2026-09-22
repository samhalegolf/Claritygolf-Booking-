/**
 * A point at a fixed distance from each of two others, nearest a third.
 *
 * The set of such points is a circle -- where a sphere of `farM` about
 * `far` meets a sphere of `nearM` about `near` -- and `preferred` picks the
 * point on it. Two joints hang on this: the heel-up ankle (tibia length from
 * the knee, foot length from the toe) and a derived elbow (upper arm from
 * the shoulder, forearm from the wrist). In both, the geometry fixes the
 * circle and only the choice of point on it is left to weaker evidence.
 *
 * If the spheres do not meet the far point is out of reach or too close;
 * either way the nearest the point can get is straight along the line
 * between them, which is what a fully straight or fully folded limb is.
 */

import type { Vec3 } from "../../contracts";
import { add, cross, distance, dot, normalise, scale, sub } from "../../contracts";

export const pointOnArc = (
  far: Vec3,
  near: Vec3,
  farM: number,
  nearM: number,
  preferred: Vec3
): Vec3 => {
  const toFar = sub(far, near);
  const d = distance(far, near);
  if (d < 1e-6) return add(near, [0, nearM, 0]);
  const axis = scale(toFar, 1 / d);

  if (d <= Math.abs(farM - nearM) || d >= farM + nearM) {
    return add(near, scale(axis, nearM));
  }

  const along = (nearM * nearM - farM * farM + d * d) / (2 * d);
  const radius = Math.sqrt(Math.max(0, nearM * nearM - along * along));
  const centre = add(near, scale(axis, along));

  // The direction on the circle nearest the preferred point.
  const offset = sub(preferred, centre);
  let radial = sub(offset, scale(axis, dot(offset, axis)));
  if (dot(radial, radial) < 1e-10) {
    // Preferred point sits on the axis: fall back to "as high as possible".
    const up: Vec3 = [0, 1, 0];
    radial = sub(up, scale(axis, dot(up, axis)));
    if (dot(radial, radial) < 1e-10) radial = cross(axis, [1, 0, 0]);
  }
  return add(centre, scale(normalise(radial), radius));
};
