// The 2D maths the Putting Lab stands on.
//
// Conventions everywhere:
//   - World plane units are millimetres; image units are frame pixels.
//   - The world plane is seen from above: +y runs down the physical target
//     line (toward the hole), +x is to the right of it.
//   - A direction angle is measured from +y toward +x, so POSITIVE MEANS RIGHT.
//     Face, path and start all use it; face-to-path is a plain subtraction.
//   - Angles are radians internally; degrees only at the edges.

export class Vec2 {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}

  static readonly zero = new Vec2(0, 0);

  add(b: Vec2) {
    return new Vec2(this.x + b.x, this.y + b.y);
  }
  sub(b: Vec2) {
    return new Vec2(this.x - b.x, this.y - b.y);
  }
  mul(s: number) {
    return new Vec2(this.x * s, this.y * s);
  }
  div(s: number) {
    return new Vec2(this.x / s, this.y / s);
  }
  neg() {
    return new Vec2(-this.x, -this.y);
  }
  dot(b: Vec2) {
    return this.x * b.x + this.y * b.y;
  }
  /** z of the 3D cross product: positive when `b` is counter-clockwise of this. */
  cross(b: Vec2) {
    return this.x * b.y - this.y * b.x;
  }
  get length() {
    return Math.hypot(this.x, this.y);
  }
  get normalized() {
    const l = this.length;
    return l > 0 ? this.div(l) : Vec2.zero;
  }
  distance(b: Vec2) {
    return Math.hypot(this.x - b.x, this.y - b.y);
  }
  /** Counter-clockwise rotation (standard maths sense, viewed from above). */
  rotated(radians: number) {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return new Vec2(c * this.x - s * this.y, s * this.x + c * this.y);
  }
  /** Unit vector for a direction angle (0 = +y, positive = toward +x). */
  static direction(angle: number) {
    return new Vec2(Math.sin(angle), Math.cos(angle));
  }
  /** Direction angle of this vector: 0 along +y, positive toward +x. */
  get directionAngle() {
    return Math.atan2(this.x, this.y);
  }
}

export const sum = (points: readonly Vec2[]) => points.reduce((a, p) => a.add(p), Vec2.zero);

export const degrees = (radians: number) => (radians * 180) / Math.PI;
export const radians = (deg: number) => (deg * Math.PI) / 180;

/** Wrap into (-pi, pi]. */
export function wrapAngle(a: number) {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

export const clampUnit = (v: number) => Math.min(1, Math.max(0, v));

// MARK: 3x3 matrices

/** Row-major 3x3 matrix acting on homogeneous 2D points. */
export type Mat3 = readonly number[];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Projective map of a point. Null only for a point on the line at infinity. */
export function apply3(m: Mat3, p: Vec2): Vec2 | null {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(w) <= 1e-12) return null;
  return new Vec2((m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w);
}

export function det3(m: Mat3) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

export function inverse3(m: Mat3): Mat3 | null {
  const d = det3(m);
  if (Math.abs(d) <= 1e-18) return null;
  const i = 1 / d;
  return [
    (m[4] * m[8] - m[5] * m[7]) * i, (m[2] * m[7] - m[1] * m[8]) * i, (m[1] * m[5] - m[2] * m[4]) * i,
    (m[5] * m[6] - m[3] * m[8]) * i, (m[0] * m[8] - m[2] * m[6]) * i, (m[2] * m[3] - m[0] * m[5]) * i,
    (m[3] * m[7] - m[4] * m[6]) * i, (m[1] * m[6] - m[0] * m[7]) * i, (m[0] * m[4] - m[1] * m[3]) * i,
  ];
}

/** Scale so m[8] == 1 where possible, purely for readable storage. */
export function normalized3(m: Mat3): Mat3 {
  return Math.abs(m[8]) > 1e-15 ? m.map((v) => v / m[8]) : m;
}

// MARK: rigid transforms

/**
 * Rotation then translation: world = R(rotation) * local + translation.
 * `rotation` is counter-clockwise radians. For a putter this is the pose that
 * carries its calibrated (square) geometry to where it is now.
 */
export class RigidTransform {
  constructor(
    readonly rotation: number,
    readonly translation: Vec2,
  ) {}

  static readonly identity = new RigidTransform(0, Vec2.zero);

  apply(p: Vec2) {
    return p.rotated(this.rotation).add(this.translation);
  }
  applyToVector(v: Vec2) {
    return v.rotated(this.rotation);
  }
  get inverse() {
    return new RigidTransform(-this.rotation, this.translation.neg().rotated(-this.rotation));
  }
  get matrix(): Mat3 {
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    return [c, -s, this.translation.x, s, c, this.translation.y, 0, 0, 1];
  }

  /**
   * Weighted least-squares rigid fit (2D Kabsch), carrying `from` onto `to`.
   * Null when the points cannot pin a rotation.
   */
  static fit(from: readonly Vec2[], to: readonly Vec2[], weights?: readonly number[]) {
    const n = Math.min(from.length, to.length);
    if (n < 2) return null;
    const w = weights ?? new Array<number>(n).fill(1);
    let sw = 0;
    let ca = Vec2.zero;
    let cb = Vec2.zero;
    for (let i = 0; i < n; i++) {
      sw += w[i];
      ca = ca.add(from[i].mul(w[i]));
      cb = cb.add(to[i].mul(w[i]));
    }
    if (sw <= 0) return null;
    ca = ca.div(sw);
    cb = cb.div(sw);
    let sDot = 0;
    let sCross = 0;
    for (let i = 0; i < n; i++) {
      const a = from[i].sub(ca);
      const b = to[i].sub(cb);
      sDot += w[i] * a.dot(b);
      sCross += w[i] * a.cross(b);
    }
    if (Math.abs(sDot) + Math.abs(sCross) <= 1e-12) return null;
    const rotation = Math.atan2(sCross, sDot);
    const transform = new RigidTransform(rotation, cb.sub(ca.rotated(rotation)));
    let se = 0;
    for (let i = 0; i < n; i++) {
      const d = transform.apply(from[i]).sub(to[i]);
      se += w[i] * d.dot(d);
    }
    return { transform, rms: Math.sqrt(se / sw) };
  }
}

// MARK: linear algebra

/** Solve A x = b (square, row-major) by Gaussian elimination with partial pivoting. */
export function linearSolve(aIn: readonly number[], bIn: readonly number[], n: number): number[] | null {
  const a = aIn.slice();
  const b = bIn.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(a[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r * n + col]) > best) {
        best = Math.abs(a[r * n + col]);
        pivot = r;
      }
    }
    if (best <= 1e-14) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) [a[col * n + c], a[pivot * n + c]] = [a[pivot * n + c], a[col * n + c]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const d = a[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r * n + c] -= f * a[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r * n + c] * x[c];
    x[r] = s / a[r * n + r];
  }
  return x;
}

// MARK: homography

/** Translate to the centroid, scale to mean distance sqrt(2). */
function normalisation(points: readonly Vec2[]): { t: Mat3; pts: Vec2[] } | null {
  const c = sum(points).div(points.length);
  let mean = 0;
  for (const p of points) mean += p.distance(c);
  mean /= points.length;
  if (mean <= 1e-12) return null;
  const s = Math.SQRT2 / mean;
  return { t: [s, 0, -s * c.x, 0, s, -s * c.y, 0, 0, 1], pts: points.map((p) => p.sub(c).mul(s)) };
}

/**
 * Least-squares homography carrying `from` onto `to` (4+ points, no three
 * collinear). Hartley-normalised DLT, h33 = 1, through the normal equations.
 */
export function solveHomography(from: readonly Vec2[], to: readonly Vec2[]): Mat3 | null {
  const n = Math.min(from.length, to.length);
  if (n < 4) return null;
  const nf = normalisation(from.slice(0, n));
  const nt = normalisation(to.slice(0, n));
  if (!nf || !nt) return null;
  const ata = new Array<number>(64).fill(0);
  const atb = new Array<number>(8).fill(0);
  const accumulate = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) ata[i * 8 + j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < n; i++) {
    const p = nf.pts[i];
    const q = nt.pts[i];
    accumulate([p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y], q.x);
    accumulate([0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y], q.y);
  }
  const h = linearSolve(ata, atb, 8);
  if (!h) return null;
  const ttInv = inverse3(nt.t);
  if (!ttInv) return null;
  return normalized3(mul3(mul3(ttInv, [...h, 1]), nf.t));
}

/** RMS distance between `to` and `h(from)`. */
export function homographyRMS(h: Mat3, from: readonly Vec2[], to: readonly Vec2[]) {
  const n = Math.min(from.length, to.length);
  if (n === 0) return Infinity;
  let se = 0;
  for (let i = 0; i < n; i++) {
    const p = apply3(h, from[i]);
    if (!p) return Infinity;
    const d = p.sub(to[i]);
    se += d.dot(d);
  }
  return Math.sqrt(se / n);
}

/** Local linear scale of a homography at a point (geometric mean of the axes). */
export function localScale(h: Mat3, p: Vec2) {
  const o = apply3(h, p);
  const ax = apply3(h, p.add(new Vec2(1, 0)));
  const ay = apply3(h, p.add(new Vec2(0, 1)));
  if (!o || !ax || !ay) return null;
  return Math.sqrt(ax.sub(o).length * ay.sub(o).length);
}

// MARK: fits

export type LineFit = { point: Vec2; direction: Vec2; rms: number };

/** Total least squares line through weighted points; direction agrees with `hint`. */
export function fitLine(pts: readonly Vec2[], weights?: readonly number[], hint?: Vec2): LineFit | null {
  if (pts.length < 2) return null;
  const w = weights ?? new Array<number>(pts.length).fill(1);
  let sw = 0;
  let c = Vec2.zero;
  pts.forEach((p, i) => {
    sw += w[i];
    c = c.add(p.mul(w[i]));
  });
  if (sw <= 0) return null;
  c = c.div(sw);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  pts.forEach((p, i) => {
    const d = p.sub(c);
    sxx += w[i] * d.x * d.x;
    syy += w[i] * d.y * d.y;
    sxy += w[i] * d.x * d.y;
  });
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dir = new Vec2(Math.cos(theta), Math.sin(theta));
  if (hint && dir.dot(hint) < 0) dir = dir.neg();
  const normal = new Vec2(-dir.y, dir.x);
  let se = 0;
  pts.forEach((p, i) => {
    const r = p.sub(c).dot(normal);
    se += w[i] * r * r;
  });
  return { point: c, direction: dir, rms: Math.sqrt(se / sw) };
}

/**
 * Weighted polynomial (degree 1 or 2) of y(t) about t0. Reads a value and its
 * rate at an instant from the frames around it, rather than the one (often
 * blurred) frame nearest that instant.
 */
export class PolyFit {
  constructor(
    readonly coefficients: number[],
    readonly t0: number,
    public rms = 0,
  ) {}

  static fit(t: readonly number[], y: readonly number[], degree: number, t0: number, weights?: readonly number[]) {
    const n = Math.min(t.length, y.length);
    const k = degree + 1;
    if (n < k || degree < 0 || degree > 2) return null;
    const w = weights ?? new Array<number>(n).fill(1);
    const ata = new Array<number>(k * k).fill(0);
    const atb = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const dt = t[i] - t0;
      const row = [1];
      for (let j = 1; j < k; j++) row.push(row[j - 1] * dt);
      for (let a = 0; a < k; a++) {
        atb[a] += w[i] * row[a] * y[i];
        for (let b = 0; b < k; b++) ata[a * k + b] += w[i] * row[a] * row[b];
      }
    }
    const c = linearSolve(ata, atb, k);
    if (!c) return null;
    const fit = new PolyFit(c, t0);
    let se = 0;
    let sw = 0;
    for (let i = 0; i < n; i++) {
      const r = fit.value(t[i]) - y[i];
      se += w[i] * r * r;
      sw += w[i];
    }
    fit.rms = sw > 0 ? Math.sqrt(se / sw) : 0;
    return fit;
  }

  value(t: number) {
    const dt = t - this.t0;
    let v = 0;
    let p = 1;
    for (const c of this.coefficients) {
      v += c * p;
      p *= dt;
    }
    return v;
  }

  rate(t: number) {
    const dt = t - this.t0;
    const c = this.coefficients;
    return (c.length > 1 ? c[1] : 0) + (c.length > 2 ? 2 * c[2] * dt : 0);
  }
}
