import type { PuttingCoordinateSystem } from "./coordinates";
import { radians, RigidTransform, Vec2, wrapAngle } from "./geometry";
import { bounds, IntRect, sample, type LumaPlane } from "./luma";
import {
  FeatureSource,
  MarkerSource,
  observationPose,
  observeEdge,
  trackingMode,
  type PositionConstraint,
  type PutterCalibration,
  type PutterObservation,
  type PutterSource,
} from "./putter";
import { BALL_RADIUS_MM } from "./template";

/** The putter at one instant, WORLD coordinates. Target-relative values are derived on read. */
export type PutterSample = {
  timestamp: number;
  /** Face centre, world mm. */
  x: number;
  y: number;
  /** Face angle against the PHYSICAL calibration line, radians, positive = right/open. */
  faceAngleWorld: number;
  /** mm/s */
  velocityX: number;
  velocityY: number;
  /** Face angle rate, rad/s, positive = opening. */
  angularVelocity: number;
  confidence: number;
  sources: PutterSource[];
};

export const putterPosition = (s: PutterSample) => new Vec2(s.x, s.y);
export const putterVelocity = (s: PutterSample) => new Vec2(s.velocityX, s.velocityY);
export const putterPose = (s: PutterSample) => new RigidTransform(-s.faceAngleWorld, putterPosition(s));

/**
 * Constant-velocity Kalman filter over the face centre (x, y, vx, vy) and the
 * pose rotation (theta, omega), updated one scalar reading at a time so a
 * source that only pins one direction (the edge) adds exactly that.
 */
class PoseFilter {
  s: number[];
  P: number[];
  theta: number[];
  thetaP: number[];
  /** A putter head can change speed by metres per second in a tenth of a second. */
  accelSigma = 12_000;
  angularAccelSigma = 25;

  constructor(pose: RigidTransform, positionSigma: number, rotationSigma: number) {
    this.s = [pose.translation.x, pose.translation.y, 0, 0];
    this.P = new Array<number>(16).fill(0);
    this.P[0] = positionSigma ** 2;
    this.P[5] = positionSigma ** 2;
    this.P[10] = 800 * 800;
    this.P[15] = 800 * 800;
    this.theta = [pose.rotation, 0];
    this.thetaP = [rotationSigma ** 2, 0, 0, 4];
  }

  get pose() {
    return new RigidTransform(this.theta[0], new Vec2(this.s[0], this.s[1]));
  }
  get positionSigma() {
    return Math.sqrt(Math.max(this.P[0], this.P[5]));
  }

  predict(dt: number) {
    if (dt <= 0) return;
    const P = this.P;
    this.s[0] += this.s[2] * dt;
    this.s[1] += this.s[3] * dt;
    const q = this.accelSigma ** 2;
    for (const [p, v] of [
      [0, 2],
      [1, 3],
    ]) {
      const pp = P[p * 4 + p];
      const pv = P[p * 4 + v];
      const vv = P[v * 4 + v];
      P[p * 4 + p] = pp + 2 * dt * pv + dt * dt * vv + (q * dt ** 4) / 4;
      P[p * 4 + v] = pv + dt * vv + (q * dt ** 3) / 2;
      P[v * 4 + p] = P[p * 4 + v];
      P[v * 4 + v] = vv + q * dt * dt;
    }
    this.theta[0] += this.theta[1] * dt;
    const qa = this.angularAccelSigma ** 2;
    const [tt, tw, , ww] = this.thetaP;
    const t01 = tw + dt * ww + (qa * dt ** 3) / 2;
    this.thetaP = [tt + 2 * dt * tw + dt * dt * ww + (qa * dt ** 4) / 4, t01, t01, ww + qa * dt * dt];
  }

  positionInnovation(c: PositionConstraint): [number, number] {
    const h = [c.normal.x, c.normal.y, 0, 0];
    let hph = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) hph += h[i] * this.P[i * 4 + j] * h[j];
    return [c.value - (h[0] * this.s[0] + h[1] * this.s[1]), hph + c.sigma * c.sigma];
  }

  updatePosition(c: PositionConstraint) {
    const h = [c.normal.x, c.normal.y, 0, 0];
    const [nu, sv] = this.positionInnovation(c);
    const ph = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) ph[i] += this.P[i * 4 + j] * h[j];
    const k = ph.map((v) => v / sv);
    for (let i = 0; i < 4; i++) this.s[i] += k[i] * nu;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) this.P[i * 4 + j] -= k[i] * ph[j];
  }

  updateRotation(r: number, sigma: number) {
    const nu = wrapAngle(r - this.theta[0]);
    const sv = this.thetaP[0] + sigma * sigma;
    const k0 = this.thetaP[0] / sv;
    const k1 = this.thetaP[2] / sv;
    this.theta[0] += k0 * nu;
    this.theta[1] += k1 * nu;
    const [p00, p01, p10, p11] = this.thetaP;
    this.thetaP = [p00 - k0 * p00, p01 - k0 * p01, p10 - k1 * p00, p11 - k1 * p01];
  }
}

/**
 * Confidence-weighted fusion ("bidding"). No source wins by being a certain
 * kind of source: each reading is weighed by its own confidence and precision
 * against where the putter was heading. A reading that disagrees with that
 * prediction is refused unless it keeps disagreeing, agrees with its peers and
 * is confident; then the track re-anchors on it.
 */
export const FUSION = { gate: 4.5, reanchorFrames: 3, reanchorConfidence: 0.8 };

function partition(observations: PutterObservation[], f: PoseFilter) {
  const accepted: PutterObservation[] = [];
  const refused: PutterObservation[] = [];
  const g2 = FUSION.gate ** 2;
  for (const o of observations) {
    let ok = true;
    if (o.rotation !== null) {
      const nu = wrapAngle(o.rotation - f.theta[0]);
      if ((nu * nu) / (f.thetaP[0] + o.rotationSigma ** 2) > g2) ok = false;
    }
    for (const c of o.constraints) {
      if (!ok) break;
      const [nu, s] = f.positionInnovation(c);
      if ((nu * nu) / s > g2) ok = false;
    }
    (ok ? accepted : refused).push(o);
  }
  return { accepted, refused };
}

function consistentChallenger(refused: PutterObservation[]) {
  const full = refused.filter((o) => observationPose(o) !== null).sort((a, b) => b.confidence - a.confidence);
  const lead = full[0];
  if (!lead || lead.confidence < FUSION.reanchorConfidence) return null;
  const leadPose = observationPose(lead)!;
  for (const other of refused) {
    if (other.source === lead.source || other.rotation === null) continue;
    if (Math.abs(wrapAngle(other.rotation - leadPose.rotation)) > radians(1.5)) return null;
  }
  return lead;
}

export type PutterStatus = "lost" | "tracking";

/** Multi-source rigid tracker for the putter head. */
export class PutterTracker {
  /** How long to coast on prediction alone before dropping the track. */
  maxPredictedSeconds = 0.06;
  status: PutterStatus = "lost";
  lastObservations: PutterObservation[] = [];
  confidence = 0;

  private filter: PoseFilter | null = null;
  private lastTimestamp: number | null = null;
  private lastAccepted = -Infinity;
  private disagreement = 0;
  private lastReacquireAttempt = -Infinity;
  private features = new FeatureSource();
  private markers = new MarkerSource();

  constructor(
    readonly calibration: PutterCalibration,
    public coordinates: PuttingCoordinateSystem,
  ) {}

  seed(pose: RigidTransform, t: number) {
    this.filter = new PoseFilter(pose, 1, radians(0.5));
    this.status = "tracking";
    this.lastTimestamp = t;
    this.lastAccepted = t;
    this.disagreement = 0;
  }

  reset() {
    this.filter = null;
    this.status = "lost";
    this.confidence = 0;
    this.lastObservations = [];
  }

  /** One frame. `address` is where the ball is: the only place a lost putter is looked for. */
  update(plane: LumaPlane, t: number, address: Vec2): PutterSample | null {
    const result = this.step(plane, t, address);
    this.lastTimestamp = t;
    return result;
  }

  private step(plane: LumaPlane, t: number, address: Vec2): PutterSample | null {
    if (this.status === "lost") {
      // Reacquisition is the only wide search, so it is throttled.
      if (t - this.lastReacquireAttempt < 1 / 20) return null;
      this.lastReacquireAttempt = t;
      const pose = this.reacquire(plane, t, address);
      if (!pose) return null;
      this.filter = new PoseFilter(pose, 0.8, radians(0.3));
      this.status = "tracking";
      this.lastAccepted = t;
      this.disagreement = 0;
    } else if (this.filter && this.lastTimestamp !== null) {
      this.filter.predict(t - this.lastTimestamp);
    }
    let f = this.filter;
    if (!f) return null;

    const cal = this.calibration;
    const c = this.coordinates;
    const predicted = f.pose;
    const sigmaPx = f.positionSigma / c.surface.mmPerPixelAtBall;
    const search = Math.min(14, Math.max(3, Math.ceil(3 * sigmaPx) + 2));
    const observations: PutterObservation[] = [];
    if (trackingMode(cal) === "enhanced") {
      const o = this.markers.observe(plane, c, cal, predicted, search, t);
      if (o) observations.push(o);
    }
    const fo = this.features.observe(plane, c, cal, predicted, search, t);
    if (fo) observations.push(fo);
    const eo = observeEdge(plane, c, cal, predicted, Math.min(10, Math.max(3, 3 * f.positionSigma + 2)), t);
    if (eo && eo.confidence > 0.2) observations.push(eo);
    this.lastObservations = observations;

    const parts = partition(observations, f);
    let accepted = parts.accepted;
    const refused = parts.refused;
    if (accepted.length === 0) {
      const challenger = consistentChallenger(refused);
      if (challenger) {
        this.disagreement++;
        const pose = observationPose(challenger);
        if (this.disagreement >= FUSION.reanchorFrames && pose) {
          // The challenger clearly wins: re-anchor rather than keep believing a stale prediction.
          const vx = f.s[2];
          const vy = f.s[3];
          f = new PoseFilter(pose, 1, challenger.rotationSigma * 2);
          f.s[2] = vx;
          f.s[3] = vy;
          accepted = [challenger];
          this.disagreement = 0;
        }
      }
    } else {
      this.disagreement = 0;
    }

    // Rotations first (they fix which way the edge constraint points), then positions.
    for (const o of accepted) {
      if (o.rotation !== null) f.updateRotation(o.rotation, o.rotationSigma / Math.sqrt(Math.max(0.05, o.confidence)));
    }
    for (const o of accepted) {
      for (const cons of o.constraints) {
        f.updatePosition({ ...cons, sigma: cons.sigma / Math.sqrt(Math.max(0.05, o.confidence)) });
      }
    }
    this.filter = f;

    if (accepted.length === 0) {
      this.confidence *= 0.85;
      if (t - this.lastAccepted > this.maxPredictedSeconds) {
        this.reset();
        return null;
      }
    } else {
      this.lastAccepted = t;
      this.confidence = 1 - accepted.reduce((a, o) => a * (1 - o.confidence), 1);
    }
    return {
      timestamp: t,
      x: f.s[0],
      y: f.s[1],
      faceAngleWorld: -f.theta[0],
      velocityX: f.s[2],
      velocityY: f.s[3],
      angularVelocity: -f.theta[1],
      confidence: this.confidence,
      sources: accepted.map((o) => o.source),
    };
  }

  /**
   * Look for the putter set up behind the ball: stickers by shape if there are
   * any, otherwise the best face-edge hypothesis near the address, confirmed
   * by the full sources before it is believed.
   */
  private reacquire(plane: LumaPlane, t: number, address: Vec2): RigidTransform | null {
    const c = this.coordinates;
    const cal = this.calibration;
    const frame = bounds(plane);
    if (trackingMode(cal) === "enhanced") {
      const zone = [new Vec2(-120, -180), new Vec2(120, -180), new Vec2(120, 20), new Vec2(-120, 20)].flatMap((p) => {
        const q = c.imageFromWorld(address.add(p));
        return q ? [q] : [];
      });
      const o = this.markers.observe(plane, c, cal, null, 0, t, IntRect.covering(zone, 4).clipped(frame));
      const pose = o ? observationPose(o) : null;
      if (o && pose && o.confidence > 0.7) return pose;
    }
    // Coarse: contrast across the expected edge, with head luma behind it.
    const columns: number[] = [];
    for (let u = -cal.faceHalfWidth * 0.8; u <= cal.faceHalfWidth * 0.8 + 1e-9; u += cal.faceHalfWidth * 0.2) columns.push(u);
    const hypotheses: Array<{ score: number; pose: RigidTransform }> = [];
    for (let dx = -50; dx <= 50; dx += 5) {
      for (let dy = -100; dy <= 2; dy += 4) {
        for (let deg = -8; deg <= 8; deg += 2) {
          const pose = new RigidTransform(radians(deg), address.add(new Vec2(dx, -BALL_RADIUS_MM + dy)));
          let total = 0;
          let head = 0;
          for (const u of columns) {
            const b = c.imageFromWorld(pose.apply(new Vec2(u, cal.edgeOffset - 2.5)));
            const fr = c.imageFromWorld(pose.apply(new Vec2(u, cal.edgeOffset + 2.5)));
            if (!b || !fr || !frame.contains(b) || !frame.contains(fr)) continue;
            const behind = sample(plane, b);
            if (Math.abs(behind - cal.headLuma) < 35) {
              head++;
              total += sample(plane, fr) - behind;
            }
          }
          if (head < columns.length - 1) continue;
          hypotheses.push({ score: Math.abs(total) / columns.length, pose });
        }
      }
    }
    hypotheses.sort((a, b) => b.score - a.score);
    for (const h of hypotheses.slice(0, 4)) {
      if (h.score <= 20) break;
      const edge = observeEdge(plane, c, cal, h.pose, 6, t);
      if (!edge || edge.confidence <= 0.5 || edge.rotation === null) continue;
      let pose = new RigidTransform(edge.rotation, h.pose.translation);
      const n = edge.constraints[0];
      if (n) {
        // Slide the hypothesis onto the measured edge.
        const off = n.value - n.normal.dot(pose.translation);
        pose = new RigidTransform(pose.rotation, pose.translation.add(n.normal.mul(off)));
      }
      if (cal.features.length >= 3) {
        const fo = this.features.observe(plane, c, cal, pose, 8, t);
        const fp = fo ? observationPose(fo) : null;
        if (!fo || fo.confidence <= 0.5 || !fp || Math.abs(wrapAngle(fp.rotation - edge.rotation)) >= radians(1.5)) continue;
        return fp;
      }
      return pose;
    }
    return null;
  }
}
