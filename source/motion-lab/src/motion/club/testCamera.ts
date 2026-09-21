/**
 * A known perspective camera, for tests.
 *
 * Built the way a real one is: an intrinsic matrix, a rotation whose rows are
 * the camera's own axes, and a translation putting the world into camera
 * coordinates. The second row is NEGATED because world Y is up and image Y is
 * down -- the single most common source of a body that reconstructs upside
 * down.
 */

import { cross, normalise, sub, type Vec3 } from "../../contracts";

export interface TestCamera {
  readonly matrix: number[];
  readonly centre: Vec3;
  readonly forward: Vec3;
}

export const perspectiveCamera = (
  centre: Vec3,
  target: Vec3,
  focal = 1.2
): TestCamera => {
  const forward = normalise(sub(target, centre));
  const right = normalise(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);

  // Rows of R: image x follows `right`, image y follows DOWN, z follows the
  // optical axis.
  const r = [
    right[0], right[1], right[2],
    -up[0], -up[1], -up[2],
    forward[0], forward[1], forward[2],
  ];
  const t = [
    -(r[0] * centre[0] + r[1] * centre[1] + r[2] * centre[2]),
    -(r[3] * centre[0] + r[4] * centre[1] + r[5] * centre[2]),
    -(r[6] * centre[0] + r[7] * centre[1] + r[8] * centre[2]),
  ];

  // K = [[f, 0, 0.5], [0, f, 0.5], [0, 0, 1]], normalised image coordinates.
  const cx = 0.5;
  const cy = 0.5;
  const matrix = [
    focal * r[0] + cx * r[6], focal * r[1] + cx * r[7], focal * r[2] + cx * r[8],
    focal * t[0] + cx * t[2],
    focal * r[3] + cy * r[6], focal * r[4] + cy * r[7], focal * r[5] + cy * r[8],
    focal * t[1] + cy * t[2],
    r[6], r[7], r[8], t[2],
  ];

  return { matrix, centre, forward };
};
