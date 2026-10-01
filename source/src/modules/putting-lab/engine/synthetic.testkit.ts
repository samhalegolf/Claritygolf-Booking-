// Synthetic frames for the engine tests: a pinhole camera over a green, a
// scene with known geometry, and putts with known face, path and start. Built
// like a real camera (a rotation and a projection), so left/right and every
// perspective effect are what a phone would see, not what the code under test
// assumes.

import { inverse3, mul3, normalized3, radians, RigidTransform, Vec2, type Mat3 } from "./geometry";
import { makePlane, type LumaPlane } from "./luma";
import { BALL_DIAMETER_MM, BALL_RADIUS_MM, TEMPLATE } from "./template";

export class SyntheticCamera {
  readonly worldToImage: Mat3;
  readonly imageToWorld: Mat3;

  /**
   * @param height lens height above the green, mm
   * @param above the world point the camera sits over
   * @param tilt degrees off vertical; @param yaw degrees turned about the lens axis
   */
  constructor(
    readonly width = 800,
    readonly heightPx = 600,
    mmPerPixel = 0.9,
    height = 1300,
    above = new Vec2(0, 150),
    tilt = 6,
    yaw = 3,
  ) {
    const f = height / mmPerPixel;
    // Camera axes in world coordinates: x right, y down the image (= world -y), z down the lens.
    let r = [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ];
    const rotate = (m: number[][], axis: 0 | 2, deg: number) => {
      const a = radians(deg);
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rot =
        axis === 0
          ? [
              [1, 0, 0],
              [0, c, -s],
              [0, s, c],
            ]
          : [
              [c, -s, 0],
              [s, c, 0],
              [0, 0, 1],
            ];
      return rot.map((row) => [0, 1, 2].map((j) => row[0] * m[0][j] + row[1] * m[1][j] + row[2] * m[2][j]));
    };
    r = rotate(r, 2, yaw);
    r = rotate(r, 0, tilt);
    const p = [above.x, above.y, height];
    const t = r.map((row) => -(row[0] * p[0] + row[1] * p[1] + row[2] * p[2]));
    const k: Mat3 = [f, 0, width / 2, 0, f, heightPx / 2, 0, 0, 1];
    const rt: Mat3 = [r[0][0], r[0][1], t[0], r[1][0], r[1][1], t[1], r[2][0], r[2][1], t[2]];
    this.worldToImage = normalized3(mul3(k, rt));
    this.imageToWorld = normalized3(inverse3(this.worldToImage)!);
  }
}

export type SyntheticScene = {
  templateDown?: boolean;
  ball?: Vec2 | null;
  putterPose?: RigidTransform | null;
  putterMarkers?: boolean;
  /** A plain black head: no sight line or engraving, only its outline. */
  plainHead?: boolean;
};

const GREEN = 105;
const PAPER = 232;
const INK = 22;
const BALL = 228;
const HEAD = 38;
const MARKERS = [new Vec2(-40, -12), new Vec2(40, -12), new Vec2(14, -22)];

/** Luma at one world point. */
function sceneLuma(scene: SyntheticScene, x: number, y: number) {
  let v = GREEN;
  if (scene.templateDown) {
    const { sheetMin, sheetMax } = TEMPLATE;
    if (x >= sheetMin.x && x <= sheetMax.x && y >= sheetMin.y && y <= sheetMax.y) {
      v = PAPER;
      // The square line for the face, faint grey.
      if (Math.abs(y - TEMPLATE.faceLineY) < 0.25 && Math.abs(x) < TEMPLATE.faceLineHalfLength && Math.abs(x) > 28 + 2) v = 150;
      for (const r of TEMPLATE.references) if (Math.hypot(x - r.position.x, y - r.position.y) <= r.radius) v = INK;
    }
  }
  if (scene.ball) {
    const d = Math.hypot(x - scene.ball.x, y - scene.ball.y);
    if (d <= BALL_RADIUS_MM) v = BALL - 25 * (d / BALL_RADIUS_MM) ** 2;
  }
  if (scene.putterPose) {
    const pose = scene.putterPose;
    const c = Math.cos(-pose.rotation);
    const s = Math.sin(-pose.rotation);
    const dx = x - pose.translation.x;
    const dy = y - pose.translation.y;
    const lx = c * dx - s * dy;
    const ly = s * dx + c * dy;
    // Shaft/hosel stub reaching back toward a right-hander's hands.
    if (lx >= -140 && lx <= -44 && ly >= -20 && ly <= -13) v = 30;
    if (lx >= -55 && lx <= 55 && ly >= -32 && ly <= 0) {
      v = HEAD;
      if (scene.plainHead) return v;
      // Sight line and a little engraving: texture for the feature tracker.
      if (Math.abs(lx) <= 1 && ly >= -26 && ly <= -5) v = 205;
      if (Math.hypot(lx - 30, ly + 14) <= 2.5 || Math.hypot(lx + 30, ly + 14) <= 2.5) v = 150;
      if (lx >= -47 && lx <= -39 && ly >= -22 && ly <= -9) v = 110;
      if (lx >= 40 && lx <= 46 && ly >= -24 && ly <= -18) v = 95;
      if (scene.putterMarkers) for (const m of MARKERS) if (Math.hypot(lx - m.x, ly - m.y) <= 4) v = 245;
    }
  }
  return v;
}

/** Renders scenes with anti-aliasing, then adds sensor noise. */
export class SyntheticRenderer {
  private seed = 0x2545f491;
  constructor(readonly camera: SyntheticCamera) {}

  render(scene: SyntheticScene): Float32Array {
    const { width: w, heightPx: h, imageToWorld: m } = this.camera;
    const at = (px: number, py: number) => {
      const wz = m[6] * px + m[7] * py + m[8];
      return sceneLuma(scene, (m[0] * px + m[1] * py + m[2]) / wz, (m[3] * px + m[4] * py + m[5]) / wz);
    };
    // Without the template the green is flat: only draw where the ball and putter can be.
    let x0 = 0;
    let y0 = 0;
    let x1 = w;
    let y1 = h;
    if (!scene.templateDown) {
      const extents: Vec2[] = [];
      if (scene.ball) for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) extents.push(scene.ball.add(new Vec2(dx, dy).mul(BALL_RADIUS_MM + 1)));
      if (scene.putterPose) for (const p of [new Vec2(-141, -33), new Vec2(56, -33), new Vec2(56, 1), new Vec2(-141, 1)]) extents.push(scene.putterPose.apply(p));
      const pixels = extents.map((p) => {
        const z = this.camera.worldToImage;
        const wz = z[6] * p.x + z[7] * p.y + z[8];
        return new Vec2((z[0] * p.x + z[1] * p.y + z[2]) / wz, (z[3] * p.x + z[4] * p.y + z[5]) / wz);
      });
      if (pixels.length === 0) return new Float32Array(w * h).fill(GREEN);
      x0 = Math.max(0, Math.floor(Math.min(...pixels.map((p) => p.x))) - 3);
      y0 = Math.max(0, Math.floor(Math.min(...pixels.map((p) => p.y))) - 3);
      x1 = Math.min(w, Math.ceil(Math.max(...pixels.map((p) => p.x))) + 3);
      y1 = Math.min(h, Math.ceil(Math.max(...pixels.map((p) => p.y))) + 3);
    }
    const out = new Float32Array(w * h).fill(GREEN);
    if (x1 <= x0 || y1 <= y0) return out;
    // Luma at every pixel corner; a pixel whose corners agree is flat.
    const corners = new Float32Array((w + 1) * (h + 1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) corners[y * (w + 1) + x] = at(x, y);
    const n = 4;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const a = corners[y * (w + 1) + x];
        if (a === corners[y * (w + 1) + x + 1] && a === corners[(y + 1) * (w + 1) + x] && a === corners[(y + 1) * (w + 1) + x + 1]) {
          out[y * w + x] = a;
          continue;
        }
        let total = 0;
        for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) total += at(x + (sx + 0.5) / n, y + (sy + 0.5) / n);
        out[y * w + x] = total / (n * n);
      }
    }
    return out;
  }

  /** A frame with fresh noise (plus or minus `noise` luma, uniform). */
  frame(clean: Float32Array, noise = 3): LumaPlane {
    const plane = makePlane(this.camera.width, this.camera.heightPx);
    for (let i = 0; i < clean.length; i++) {
      let s = this.seed;
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      this.seed = s >>> 0;
      const u = this.seed / 4294967296;
      plane.data[i] = Math.max(0, Math.min(255, Math.round(clean[i] + (u * 2 - 1) * noise)));
    }
    return plane;
  }
}

/** A putt with known truth; angles in degrees against the physical line. */
export class SyntheticPutt {
  face = 1;
  path = -0.5;
  start = 0.7;
  ballRest = new Vec2(1.5, -0.8);
  /** Face centre sits this far behind the ball at address. */
  addressGap = 5;
  backswing = 170;
  downswingSeconds = 0.3;
  backswingSeconds = 0.55;
  addressSeconds = 0.6;
  smash = 1.3;
  /** Face opening per mm the head is behind impact (degrees/mm). */
  faceRotationPerMM = 0.012;
  arc = 0.0004;

  constructor(init: Partial<Pick<SyntheticPutt, "face" | "path" | "start" | "backswing" | "downswingSeconds">> = {}) {
    Object.assign(this, init);
  }

  get omega() {
    return Math.PI / 2 / this.downswingSeconds;
  }
  get topTime() {
    return this.addressSeconds + this.backswingSeconds;
  }
  get impactTime() {
    return this.topTime + Math.acos(-this.addressGap / this.backswing) / this.omega;
  }
  get direction() {
    return Vec2.direction(radians(this.path));
  }
  get address() {
    return this.ballRest.sub(new Vec2(0, BALL_DIAMETER_MM / 2 + this.addressGap));
  }

  s(t: number) {
    if (t <= this.addressSeconds) return 0;
    if (t <= this.topTime) return (-this.backswing * (1 - Math.cos((Math.PI * (t - this.addressSeconds)) / this.backswingSeconds))) / 2;
    return -this.backswing * Math.cos(this.omega * (t - this.topTime));
  }

  putterPose(t: number) {
    const sv = this.s(t);
    const impactPoint = this.address.add(new Vec2(0, this.addressGap));
    const perp = this.direction.rotated(Math.PI / 2);
    const along = sv - this.addressGap;
    const position = impactPoint.add(this.direction.mul(along)).add(perp.mul(this.arc * along * along));
    const faceAngle = this.face + this.faceRotationPerMM * (this.addressGap - sv);
    return new RigidTransform(-radians(faceAngle), position);
  }

  get ballSpeed() {
    return this.backswing * this.omega * Math.sin(Math.acos(-this.addressGap / this.backswing)) * this.smash;
  }

  ballPosition(t: number) {
    if (t <= this.impactTime) return this.ballRest;
    const tau = t - this.impactTime;
    return this.ballRest.add(Vec2.direction(radians(this.start)).mul(this.ballSpeed * tau - 0.5 * 600 * tau * tau));
  }
}
