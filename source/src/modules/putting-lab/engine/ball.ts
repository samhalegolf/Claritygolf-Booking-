import { BlobDetector } from "./blobs";
import type { PuttingCoordinateSystem } from "./coordinates";
import { clampUnit, PolyFit, radians, sum, Vec2 } from "./geometry";
import { bounds, histogram, IntRect, otsu, type LumaPlane } from "./luma";
import { BALL_RADIUS_MM } from "./template";

/** The ball at one instant, WORLD millimetres. Plain data so it crosses to and from a worker. */
export type BallSample = {
  timestamp: number;
  x: number;
  y: number;
  /** mm/s */
  velocityX: number;
  velocityY: number;
  radiusMM: number;
  confidence: number;
  /** Dark marks seen on the ball (a three-dot ball), world mm. Kept for later spin work. */
  dots: Array<{ x: number; y: number }>;
};

export const ballPosition = (s: BallSample) => new Vec2(s.x, s.y);
export const ballVelocity = (s: BallSample) => new Vec2(s.velocityX, s.velocityY);

export type BallObservation = { imageCenter: Vec2; imageRadius: number; dots: Vec2[]; confidence: number };

/**
 * Finds a white ball in a small window. The lab always knows roughly where the
 * ball is, so this never scans the frame: it thresholds one window and picks
 * the round bright thing of the right size.
 */
export class BallDetector {
  private blobs = new BlobDetector();
  private dotBlobs = new BlobDetector();

  detect(plane: LumaPlane, center: Vec2, expectedRadius: number, searchRadius: number): BallObservation | null {
    const half = searchRadius + expectedRadius * 1.6;
    const roi = IntRect.covering([center], half).clipped(bounds(plane));
    if (roi.area <= 16) return null;
    const { threshold, separability } = otsu(histogram(plane, roi, roi.area > 40_000 ? 2 : 1));
    if (separability <= 0.3) return null;
    const expectedArea = Math.PI * expectedRadius * expectedRadius;
    const found = this.blobs.detect(
      plane,
      roi,
      { kind: "brighterThan", value: threshold },
      1,
      Math.floor(expectedArea * 0.35),
      Math.floor(expectedArea * 3),
    );
    let best: { blob: (typeof found)[number]; score: number } | null = null;
    for (const b of found) {
      // Motion blur stretches a rolling ball; the short axis still gives its size.
      const minorRadius = 2 * Math.sqrt(b.axes[1]);
      const sizeMatch = 1 - Math.min(1, Math.abs(minorRadius / expectedRadius - 1) * 2.5);
      const roundness = 1 - Math.min(1, (b.elongation - 1) / 2);
      const fill = Math.min(1, b.fillRatio / 0.7);
      const distance = b.centroid.distance(center);
      if (distance > searchRadius + expectedRadius * 0.5) continue;
      const nearness = 1 - Math.min(1, distance / Math.max(1, searchRadius + expectedRadius));
      const score = sizeMatch * 0.4 + roundness * 0.25 + fill * 0.15 + nearness * 0.2;
      if (b.touchesEdge) continue;
      if (score > (best?.score ?? 0.45)) best = { blob: b, score };
    }
    if (!best) return null;
    const b = best.blob;
    const radius = 2 * Math.sqrt(b.axes[1]);
    let dots: Vec2[] = [];
    if (radius > 6) {
      dots = this.dotBlobs
        .detect(plane, b.bounds, { kind: "darkerThan", value: threshold }, 1, 2, Math.floor(radius * radius * 0.4))
        .filter((d) => !d.touchesEdge && d.centroid.distance(b.centroid) < radius * 0.85)
        .map((d) => d.centroid);
    }
    return { imageCenter: b.centroid, imageRadius: radius, dots, confidence: clampUnit(best.score * Math.min(1, separability / 0.6)) };
  }
}

export type BallStatus = "absent" | "settling" | "atRest" | "rolling" | "finished";

/** Half the side of the square box, mm, about the calibrated spot (squared to the aim) that a ball must sit in. */
export const BALL_BOX_HALF_MM = 30;

/** Is a ball centre, in TARGET coordinates, inside the ball box? */
export const inBallBox = (p: Vec2) => Math.abs(p.x) <= BALL_BOX_HALF_MM && Math.abs(p.y) <= BALL_BOX_HALF_MM;

/** At rest near the start, then frame to frame along its predicted path. Never scans the frame. */
export class BallTracker {
  settleSeconds = 0.3;
  /** Movement from rest that means the ball has been struck. */
  departureThreshold = 2.5;
  /** The fastest putt to follow, mm/s: sizes the search around a ball at rest. */
  maxBallSpeed = 2000;

  status: BallStatus = "absent";
  restPosition: Vec2 | null = null;
  last: BallSample | null = null;
  /** Samples since the ball left its rest position. */
  roll: BallSample[] = [];
  lastSearch: { center: Vec2; radius: number } | null = null;

  private detector = new BallDetector();
  private settleSamples: BallSample[] = [];
  private restNoise = 0.3;
  private departureSample: BallSample | null = null;
  private frameSpacing = 1 / 240;
  private lastFrame: number | null = null;
  private misses = 0;

  constructor(public coordinates: PuttingCoordinateSystem) {}

  reset() {
    this.status = "absent";
    this.restPosition = null;
    this.last = null;
    this.roll = [];
    this.settleSamples = [];
    this.departureSample = null;
    this.misses = 0;
  }

  /** Forget the finished putt and look for the next ball at the start. */
  rearm() {
    this.reset();
  }

  update(plane: LumaPlane, t: number): BallSample | null {
    if (this.lastFrame !== null && t > this.lastFrame) this.frameSpacing = this.frameSpacing * 0.9 + (t - this.lastFrame) * 0.1;
    this.lastFrame = t;
    const c = this.coordinates;
    const mmpp = c.surface.mmPerPixelAtBall;
    const expectedRadius = BALL_RADIUS_MM / mmpp;

    if (this.status === "finished") return null;
    if (this.status === "rolling") {
      const prev = this.last;
      if (!prev) {
        this.status = "finished";
        return null;
      }
      const dt = t - prev.timestamp;
      const predicted = ballPosition(prev).add(ballVelocity(prev).mul(dt));
      // Early on the velocity is a guess, so look wider.
      const searchMM = Math.max(10, ballVelocity(prev).mul(dt).length * 0.6 + 6) + (this.roll.length < 3 ? 20 : 0);
      const centre = c.imageFromWorld(predicted);
      if (!centre || !bounds(plane).contains(centre)) {
        this.status = "finished";
        return null;
      }
      this.lastSearch = { center: centre, radius: searchMM / mmpp };
      const o = this.detector.detect(plane, centre, expectedRadius, searchMM / mmpp);
      const sample = o ? this.makeSample(o, t) : null;
      if (!sample) {
        this.misses++;
        if (this.misses > 4) this.status = "finished";
        return null;
      }
      this.misses = 0;
      // Velocity from a short least-squares window: steadier than one difference.
      const window = [...this.roll.slice(-4), sample];
      const ts = window.map((s) => s.timestamp);
      const fx = PolyFit.fit(ts, window.map((s) => s.x), 1, t);
      const fy = PolyFit.fit(ts, window.map((s) => s.y), 1, t);
      if (fx && fy) {
        sample.velocityX = fx.rate(t);
        sample.velocityY = fy.rate(t);
      }
      this.roll.push(sample);
      this.last = sample;
      return sample;
    }

    // absent, settling or at rest
    const centreWorld = this.restPosition ?? c.surface.ballOrigin;
    // At rest the window must still catch a firmly struck ball two frames in,
    // however far apart the frames are (30 frames a second is ~50 mm a frame).
    const searchMM = this.status === "atRest" ? Math.max(45, 2.2 * this.maxBallSpeed * this.frameSpacing) : BALL_BOX_HALF_MM * Math.SQRT2;
    const centre = c.imageFromWorld(centreWorld);
    if (!centre) return null;
    this.lastSearch = { center: centre, radius: searchMM / mmpp };
    const o = this.detector.detect(plane, centre, expectedRadius, searchMM / mmpp);
    const sample = o ? this.makeSample(o, t) : null;
    if (!sample) {
      if (this.status === "atRest") {
        // Gone between frames: struck hard or picked up.
        this.misses++;
        if (this.misses > 3) this.reset();
      } else {
        this.reset();
      }
      return null;
    }
    const position = ballPosition(sample);
    if (this.status !== "atRest" && !inBallBox(c.targetFromWorld(position))) {
      this.reset();
      return null;
    }
    if (this.status === "atRest" && this.restPosition) {
      const rest = this.restPosition;
      const away = position.sub(rest);
      if (away.length > Math.max(this.departureThreshold, 4 * this.restNoise)) {
        const firstMove = this.departureSample;
        this.departureSample = sample;
        // A struck ball leaves in a straight line: two sightings off the spot
        // that do not line up are something else (the ball lifted away, a bright patch).
        const firstAway = firstMove ? ballPosition(firstMove).sub(rest) : null;
        const inLine = firstAway !== null && away.length > firstAway.length && away.dot(firstAway) > away.length * firstAway.length * Math.cos(radians(25));
        if (firstMove && inLine) {
          this.misses = 0;
          // Leave already moving: with frames far apart, a roll that starts
          // from standstill would search behind the ball.
          const dt = sample.timestamp - firstMove.timestamp;
          if (dt > 0) {
            sample.velocityX = (sample.x - firstMove.x) / dt;
            sample.velocityY = (sample.y - firstMove.y) / dt;
          }
          this.status = "rolling";
          this.roll = [firstMove, sample];
          this.last = sample;
          return sample;
        }
        // Not a putt yet, and not the ball at rest either.
        this.misses++;
        if (this.misses > 3) {
          this.reset();
          return null;
        }
      } else {
        this.misses = 0;
        this.departureSample = null;
        // Follow a slow creep, keep the rest position steady otherwise.
        this.restPosition = rest.add(position.sub(rest).mul(0.1));
      }
      this.last = sample;
      return sample;
    }
    this.misses = 0;
    this.settleSamples.push(sample);
    this.settleSamples = this.settleSamples.filter((s) => s.timestamp >= t - this.settleSeconds - 0.05);
    this.status = "settling";
    const first = this.settleSamples[0];
    if (first && t - first.timestamp >= this.settleSeconds) {
      const points = this.settleSamples.map(ballPosition);
      const mean = sum(points).div(points.length);
      const spread = Math.max(...points.map((p) => p.distance(mean)));
      if (spread < 1) {
        const rms = Math.sqrt(points.reduce((a, p) => a + p.distance(mean) ** 2, 0) / points.length);
        this.restNoise = Math.max(0.15, rms);
        this.restPosition = mean;
        this.status = "atRest";
        this.departureSample = null;
      }
    }
    this.last = sample;
    return sample;
  }

  private makeSample(o: BallObservation, t: number): BallSample | null {
    const c = this.coordinates;
    const w = c.worldFromImage(o.imageCenter);
    const edge = c.worldFromImage(o.imageCenter.add(new Vec2(o.imageRadius, 0)));
    if (!w || !edge) return null;
    return {
      timestamp: t,
      x: w.x,
      y: w.y,
      velocityX: 0,
      velocityY: 0,
      radiusMM: w.distance(edge),
      confidence: o.confidence,
      dots: o.dots.flatMap((d) => {
        const p = c.worldFromImage(d);
        return p ? [{ x: p.x, y: p.y }] : [];
      }),
    };
  }
}
