/**
 * Working out where the camera was, from the golfer.
 *
 * THE PROBLEM
 *
 * A clubhead detector finds the club in the IMAGE -- two numbers. The CBP has
 * to live in 3D. Bridging that normally needs a calibrated camera, and nobody
 * calibrates a phone before filming a swing.
 *
 * But the body is already a calibration rig. Every observed joint carries its
 * 3D world position AND the image position it was detected at, so twenty
 * correspondences arrive free with every frame.
 *
 * WHY A FULL PROJECTIVE CAMERA, AND NOT AN AFFINE ONE
 *
 * An affine (scaled-orthographic) camera is tempting: it is a plain least
 * squares with no initial guess and no failure mode. It was the first thing
 * built here, and it was wrong for a reason worth recording.
 *
 * An affine camera has no perspective, so its errors grow with distance from
 * the volume it was fitted over. It is calibrated on the body, which is about
 * a metre deep -- and then used on a CLUBHEAD that swings a further metre
 * outside it. Measured end to end, that extrapolation inflated the estimated
 * club length by 13 to 20 per cent, and a club that is 20% too long puts the
 * clubhead's depth badly wrong on every frame.
 *
 * A projective camera is still linear if the last element is pinned, so it is
 * solved the same way -- normal equations, no iteration, no initialisation --
 * and it models the perspective that actually caused the error.
 *
 * WHAT IT STILL CANNOT DO
 *
 * Recover depth. Every point along a ray from the camera centre projects to
 * the same pixel. That is not a flaw to be fixed here -- it is why the club
 * model exists. The clubhead's distance from the hands is what pins it down,
 * and this file only supplies the ray it must lie on.
 */

import type { Unit, Vec3 } from "../../contracts";
import { clampUnit, cross, dot, normalise, sub } from "../../contracts";

/** One 3D point and the image position it was seen at. */
export interface Correspondence {
  readonly world: Vec3;
  /** Normalised image coordinates, Y DOWN. */
  readonly image: readonly [number, number];
  /** How much this correspondence is trusted, 0..1. */
  readonly weight: number;
}

export interface Camera {
  /** Row-major 3x4 projection: [u; v; w] = P * [X, Y, Z, 1], then divide by w. */
  readonly matrix: readonly number[];
  /** Where the camera was, in world metres. */
  readonly centre: Vec3;
  /** Unit vector down the optical axis, away from the camera. */
  readonly viewing: Vec3;
  /** RMS reprojection error, in normalised image units. */
  readonly residual: number;
  /** How well-conditioned the fit was, 0..1. Low means degenerate geometry. */
  readonly conditioning: Unit;
  readonly sampleCount: number;
}

/* -------------------------- linear algebra -------------------------- */

/**
 * Solve a small dense system by Gaussian elimination with partial pivoting.
 * Returns null when the matrix is singular -- which happens for real reasons
 * here (a body seen edge-on is nearly planar) and must be reported, not
 * papered over with a pseudo-solution.
 */
const solveLinear = (a: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x;
};

/** Inverse of a 3x3, row-major. Null when singular. */
const invert3 = (m: readonly number[]): number[] | null => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-14) return null;
  return [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
};

const apply3 = (m: readonly number[], v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/* ------------------------------ the fit ----------------------------- */

/** Eleven unknowns need at least six points; fewer is a formality. */
const MIN_CORRESPONDENCES = 7;

export const fitCamera = (correspondences: readonly Correspondence[]): Camera | null => {
  const usable = correspondences.filter((entry) => entry.weight > 0.05);
  if (usable.length < MIN_CORRESPONDENCES) return null;

  /*
   * Hartley normalisation, and it is not optional.
   *
   * The design matrix mixes raw metres with products of metres and image
   * coordinates, so without centring and scaling both sides its columns
   * differ by orders of magnitude and the normal equations lose most of their
   * precision. Centring each cloud and scaling to unit average radius fixes
   * the conditioning; the transform is undone afterwards.
   */
  const worldCentre = usable
    .reduce<[number, number, number]>(
      (sum, entry) => [
        sum[0] + entry.world[0] / usable.length,
        sum[1] + entry.world[1] / usable.length,
        sum[2] + entry.world[2] / usable.length,
      ],
      [0, 0, 0]
    );
  const imageCentre = usable.reduce<[number, number]>(
    (sum, entry) => [
      sum[0] + entry.image[0] / usable.length,
      sum[1] + entry.image[1] / usable.length,
    ],
    [0, 0]
  );

  const worldSpread =
    usable.reduce(
      (sum, entry) => sum + Math.hypot(...sub(entry.world, worldCentre as Vec3)),
      0
    ) / usable.length;
  const imageSpread =
    usable.reduce(
      (sum, entry) =>
        sum + Math.hypot(entry.image[0] - imageCentre[0], entry.image[1] - imageCentre[1]),
      0
    ) / usable.length;

  if (worldSpread < 1e-6 || imageSpread < 1e-9) return null;
  const worldScale = Math.sqrt(3) / worldSpread;
  const imageScale = Math.sqrt(2) / imageSpread;

  // Eleven unknowns: the projection with its last element pinned to one.
  const ata: number[][] = Array.from({ length: 11 }, () => new Array<number>(11).fill(0));
  const atb = new Array<number>(11).fill(0);

  const addRow = (row: number[], value: number, weight: number) => {
    for (let i = 0; i < 11; i += 1) {
      for (let j = 0; j < 11; j += 1) ata[i][j] += weight * row[i] * row[j];
      atb[i] += weight * row[i] * value;
    }
  };

  for (const entry of usable) {
    const X = (entry.world[0] - worldCentre[0]) * worldScale;
    const Y = (entry.world[1] - worldCentre[1]) * worldScale;
    const Z = (entry.world[2] - worldCentre[2]) * worldScale;
    const u = (entry.image[0] - imageCentre[0]) * imageScale;
    const v = (entry.image[1] - imageCentre[1]) * imageScale;

    addRow([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z], u, entry.weight);
    addRow([0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z], v, entry.weight);
  }

  const solved = solveLinear(ata.map((row) => [...row]), [...atb]);
  if (!solved) return null;

  const normalised = [...solved, 1];

  /*
   * Undo the normalisation: P = inv(Timage) * Pnorm * Tworld, with both
   * transforms being a translation followed by a uniform scale.
   */
  const matrix = new Array<number>(12).fill(0);
  for (let row = 0; row < 3; row += 1) {
    // Pnorm row, folded through the world transform.
    const a = normalised[row * 4];
    const b = normalised[row * 4 + 1];
    const c = normalised[row * 4 + 2];
    const d = normalised[row * 4 + 3];

    const scaled = [a * worldScale, b * worldScale, c * worldScale];
    const offset =
      d -
      worldScale * (a * worldCentre[0] + b * worldCentre[1] + c * worldCentre[2]);

    matrix[row * 4] = scaled[0];
    matrix[row * 4 + 1] = scaled[1];
    matrix[row * 4 + 2] = scaled[2];
    matrix[row * 4 + 3] = offset;
  }

  // Now the image side: u = un / imageScale + centre, applied to rows 0 and 1
  // relative to row 2 (the homogeneous row).
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      matrix[row * 4 + col] =
        matrix[row * 4 + col] / imageScale + imageCentre[row] * matrix[8 + col];
    }
  }

  const M = [
    matrix[0], matrix[1], matrix[2],
    matrix[4], matrix[5], matrix[6],
    matrix[8], matrix[9], matrix[10],
  ];
  const inverse = invert3(M);
  if (!inverse) return null;

  const p4: Vec3 = [matrix[3], matrix[7], matrix[11]];
  const centreVec = apply3(inverse, p4);
  const centre: Vec3 = [-centreVec[0], -centreVec[1], -centreVec[2]];
  if (!Number.isFinite(centre[0] + centre[1] + centre[2])) return null;

  let squared = 0;
  let weightTotal = 0;
  for (const entry of usable) {
    const projected = project(matrix, entry.world);
    if (!projected) return null;
    squared +=
      entry.weight *
      ((projected[0] - entry.image[0]) ** 2 + (projected[1] - entry.image[1]) ** 2);
    weightTotal += entry.weight;
  }

  // The optical axis is the third row of M, pointing away from the camera.
  const viewing = normalise([M[6], M[7], M[8]]);

  /*
   * Conditioning: is the calibration cloud genuinely three-dimensional?
   *
   * Measured as the spread in its THINNEST direction against an absolute
   * threshold, not against its thickest. The first version used the ratio,
   * which quietly punished every camera for the fact that people are taller
   * than they are deep -- a perfectly good fit scored 0.22 and dragged the
   * club's confidence down with it.
   *
   * What actually matters is whether there is enough depth to pin a
   * projection down at all. A standing body gives 100mm or more of spread
   * front to back; a body seen so edge-on that its joints are nearly coplanar
   * gives almost none, and a camera fitted to a plane cannot speak about
   * depth.
   */
  const conditioning = clampUnit(thinnestSpread(usable.map((entry) => entry.world)) / 0.06);

  return {
    matrix,
    centre,
    viewing,
    residual: weightTotal > 0 ? Math.sqrt(squared / weightTotal) : Number.POSITIVE_INFINITY,
    conditioning,
    sampleCount: usable.length,
  };
};

/** Standard deviation along the axis the cloud is thinnest in, metres. */
const thinnestSpread = (points: readonly Vec3[]): number => {
  if (points.length < 4) return 0;
  const centre: Vec3 = [
    points.reduce((sum, p) => sum + p[0], 0) / points.length,
    points.reduce((sum, p) => sum + p[1], 0) / points.length,
    points.reduce((sum, p) => sum + p[2], 0) / points.length,
  ];
  const extent = [0, 1, 2].map((axis) =>
    Math.sqrt(
      points.reduce((sum, p) => sum + (p[axis] - centre[axis]) ** 2, 0) / points.length
    )
  );
  return Math.min(...extent);
};

/** Project a world point. Null when it lands behind or on the camera plane. */
export const project = (
  matrix: readonly number[],
  point: Vec3
): [number, number] | null => {
  const w =
    matrix[8] * point[0] + matrix[9] * point[1] + matrix[10] * point[2] + matrix[11];
  if (Math.abs(w) < 1e-12) return null;
  return [
    (matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2] + matrix[3]) / w,
    (matrix[4] * point[0] + matrix[5] * point[1] + matrix[6] * point[2] + matrix[7]) / w,
  ];
};

/* ------------------------------ lifting ----------------------------- */

/**
 * The ray an image position could have come from: out of the camera centre,
 * through that pixel, to infinity.
 */
export const viewingRay = (
  camera: Camera,
  image: readonly [number, number]
): { origin: Vec3; direction: Vec3 } | null => {
  const m = camera.matrix;
  const M = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const inverse = invert3(M);
  if (!inverse) return null;

  const direction = normalise(apply3(inverse, [image[0], image[1], 1]));
  if (!Number.isFinite(direction[0] + direction[1] + direction[2])) return null;

  // Point it away from the camera, so "near" and "far" mean what they say.
  const forward = dot(direction, camera.viewing) >= 0 ? direction : normalise([
    -direction[0],
    -direction[1],
    -direction[2],
  ]);

  return { origin: camera.centre, direction: forward };
};

export interface SphereLift {
  readonly position: Vec3;
  /**
   * How the ambiguity was resolved:
   *   "near"/"far"  the ray cut the sphere twice and one was chosen
   *   "tangent"     one solution; the club is side-on to the camera
   *   "projected"   the ray missed the sphere entirely, so the nearest point
   *                 on it was used. The detection and the club length
   *                 disagree, and the caller should say so.
   */
  readonly branch: "near" | "far" | "tangent" | "projected";
  /** Metres the ray missed the sphere by. Zero unless `branch` is "projected". */
  readonly missM: number;
  /**
   * Separation of the two candidates, metres. Small means the depth was
   * barely determined and the choice hardly mattered; large means picking the
   * wrong one would have put the clubhead a long way out.
   */
  readonly ambiguityM: number;
}

/**
 * Put an image detection onto a sphere of known radius around a known centre.
 *
 * This is the whole 2D-to-3D step. The image gives a ray; the club's length
 * gives a sphere around the hands; the clubhead is where they meet. Two
 * intersections usually exist -- the club pointing toward the camera or away
 * -- and `preferNear` resolves it from continuity and physics rather than
 * from anything about golf.
 */
export const liftOntoSphere = (
  ray: { origin: Vec3; direction: Vec3 },
  centre: Vec3,
  radius: number,
  preferNear: boolean
): SphereLift => {
  const w = sub(ray.origin, centre);
  const d = ray.direction;

  const a = dot(d, d);
  const b = 2 * dot(w, d);
  const c = dot(w, w) - radius * radius;
  const discriminant = b * b - 4 * a * c;

  if (discriminant < 0) {
    /*
     * The ray misses the sphere: the clubhead appears further from the hands
     * than the club is long. Real and common -- a detection a few pixels out,
     * or a club length still settling. The nearest point on the ray is
     * projected onto the sphere, and the miss distance is reported so the
     * caller can lose confidence rather than quietly accept it.
     */
    const t = -b / (2 * a);
    const nearest: Vec3 = [
      ray.origin[0] + d[0] * t,
      ray.origin[1] + d[1] * t,
      ray.origin[2] + d[2] * t,
    ];
    const offset = sub(nearest, centre);
    const distance = Math.hypot(...offset);
    return {
      position:
        distance < 1e-9
          ? [centre[0] + radius, centre[1], centre[2]]
          : [
              centre[0] + (offset[0] / distance) * radius,
              centre[1] + (offset[1] / distance) * radius,
              centre[2] + (offset[2] / distance) * radius,
            ],
      branch: "projected",
      missM: distance - radius,
      ambiguityM: 0,
    };
  }

  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  const at = (t: number): Vec3 => [
    ray.origin[0] + d[0] * t,
    ray.origin[1] + d[1] * t,
    ray.origin[2] + d[2] * t,
  ];

  const ambiguityM = Math.abs(t2 - t1) * Math.hypot(...d);
  if (root < 1e-9) {
    return { position: at(t1), branch: "tangent", missM: 0, ambiguityM };
  }

  const nearT = Math.min(t1, t2);
  const farT = Math.max(t1, t2);
  return {
    position: at(preferNear ? nearT : farT),
    branch: preferNear ? "near" : "far",
    missM: 0,
    ambiguityM,
  };
};

export { cross };
