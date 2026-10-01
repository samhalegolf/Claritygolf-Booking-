import { ballPosition, type BallSample } from "./ball";
import type { PracticeTarget, PracticeGate } from "./coordinates";
import { clampUnit, degrees, fitLine, PolyFit, radians, Vec2, wrapAngle } from "./geometry";
import type { Handedness, PutterTrackingMode } from "./putter";
import { BALL_RADIUS_MM } from "./template";
import { putterPosition, putterVelocity, type PutterSample } from "./tracker";

/** When the putter met the ball, from two independent witnesses. */
export type ImpactEstimate = {
  time: number;
  /** Ball displacement extrapolated back to zero. */
  fromBall: number | null;
  /** Face reaching the back of the ball. */
  fromPutter: number | null;
  confidence: number;
};

/**
 * The impact instant. The ball's departure is the steadier witness; the
 * putter's arrival at the ball confirms it. Neither depends on the one blurred
 * frame nearest contact.
 */
export function estimateImpact(ballRest: Vec2, roll: BallSample[], putter: PutterSample[], ballRadius = BALL_RADIUS_MM): ImpactEstimate | null {
  let fromBall: number | null = null;
  const early = roll
    .filter((s) => {
      const d = ballPosition(s).distance(ballRest);
      return d >= 2 && d <= 120;
    })
    .slice(0, 8);
  if (early.length >= 2) {
    const ts = early.map((s) => s.timestamp);
    const f = PolyFit.fit(ts, early.map((s) => ballPosition(s).distance(ballRest)), 1, ts[0]);
    if (f && f.rate(ts[0]) > 50) fromBall = ts[0] - f.value(ts[0]) / f.rate(ts[0]);
  }

  let fromPutter: number | null = null;
  const reference = fromBall ?? roll[0]?.timestamp ?? putter[putter.length - 1]?.timestamp ?? 0;
  // Signed gap between the face and the back of the ball, along the face normal.
  const gap = (s: PutterSample) => Vec2.direction(s.faceAngleWorld).dot(ballRest.sub(putterPosition(s))) - ballRadius;
  const window = putter.filter((s) => s.timestamp <= reference + 0.03 && s.timestamp >= reference - 0.3 && s.confidence > 0.3);
  for (let i = window.length - 1; i > 0; i--) {
    const a = window[i - 1];
    const b = window[i];
    const ga = gap(a);
    const gb = gap(b);
    if (ga > 0 && gb <= 0) {
      fromPutter = a.timestamp + ((b.timestamp - a.timestamp) * ga) / (ga - gb);
      break;
    }
  }

  if (fromBall !== null && fromPutter !== null && Math.abs(fromBall - fromPutter) < 0.012) {
    return { time: 0.6 * fromBall + 0.4 * fromPutter, fromBall, fromPutter, confidence: 0.95 };
  }
  if (fromBall !== null) return { time: fromBall, fromBall, fromPutter, confidence: fromPutter === null ? 0.75 : 0.6 };
  if (fromPutter !== null) return { time: fromPutter, fromBall, fromPutter, confidence: 0.5 };
  return null;
}

/** A value and how far it can be trusted. */
export type Measured = { value: number; confidence: number };

export type GateResult = { gate: PracticeGate; passed: boolean; lateral: number };

/** Angles are DEGREES against the aim line, positive = right. Face-to-path is face minus path. */
export type PuttingStrokeMetrics = {
  face: Measured | null;
  path: Measured | null;
  faceToPath: Measured | null;
  start: Measured | null;
  /** m/s just after the ball leaves the face. */
  ballSpeed: Measured | null;
  /** Ball centre relative to face centre at impact, mm, positive = toward the toe. */
  strikePoint: Measured | null;
  /** Face change from address to impact, degrees (positive = opened). */
  faceRotation: Measured | null;
  /** Degrees per second at impact (positive = opening). */
  faceRotationRate: Measured | null;
  /** Side-to-side range of the face centre through the stroke, mm. */
  lateralMovement: Measured | null;
  backswingLength: Measured | null;
  backswingTime: number | null;
  downswingTime: number | null;
  gates: GateResult[];
  confidence: number;
};

/** One putt, with the raw samples kept so every number can be recalculated later. */
export type PuttingStroke = {
  id: string;
  startedAt: number;
  impact: ImpactEstimate;
  /** Where the ball sat before it was struck, world mm. */
  ballRest: { x: number; y: number };
  putterSamples: PutterSample[];
  ballSamples: BallSample[];
  trackingMode: PutterTrackingMode;
  handedness: Handedness;
  /** The aim when it was read (the metrics are against it). */
  target: PracticeTarget;
  metrics: PuttingStrokeMetrics;
};

/**
 * Time either side of impact used to read the face, and (wider) the path. At
 * least these, and never fewer frames than a fit needs: at 60 frames a second
 * 25 ms holds one frame, at 240 it holds six.
 */
function impactWindows(putter: PutterSample[]) {
  const gaps = putter.slice(1).map((s, i) => s.timestamp - putter[i].timestamp).sort((a, b) => a - b);
  const dt = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1 / 240;
  return {
    face: { before: Math.max(0.025, 3.5 * dt), after: Math.max(0.008, 1.5 * dt) },
    path: { before: Math.max(0.04, 4.5 * dt), after: Math.max(0.015, 2 * dt) },
  };
}

/** The widest start line, radians either side of the aim, that takes the ball through a gate clean. */
export const gateTolerance = (g: PracticeGate) => Math.atan2(g.width / 2 - BALL_RADIUS_MM, g.distance);

export function analyseStroke(
  putter: PutterSample[],
  roll: BallSample[],
  ballRest: Vec2,
  impact: ImpactEstimate,
  target: PracticeTarget,
  handedness: Handedness,
  startedAt: number,
): PuttingStrokeMetrics {
  const aim = target.aimOffset;
  const ti = impact.time;
  const r = BALL_RADIUS_MM;

  // Face and path at impact, from local fits through the surrounding frames.
  const windows = impactWindows(putter);
  const near = putter.filter((s) => s.timestamp >= ti - windows.face.before && s.timestamp <= ti + windows.face.after && s.confidence > 0.2);
  let face: Measured | null = null;
  let path: Measured | null = null;
  let rate: Measured | null = null;
  let strike: Measured | null = null;
  let faceAtImpactWorld: number | null = null;
  if (near.length >= 4) {
    const ts = near.map((s) => s.timestamp);
    const w = near.map((s) => s.confidence);
    const conf = (w.reduce((a, b) => a + b, 0) / w.length) * Math.min(1, near.length / 5);
    const ff = PolyFit.fit(ts, near.map((s) => s.faceAngleWorld), 2, ti, w);
    if (ff) {
      faceAtImpactWorld = ff.value(ti);
      face = { value: degrees(wrapAngle(ff.value(ti) - aim)), confidence: conf * impact.confidence };
      rate = { value: degrees(ff.rate(ti)), confidence: conf };
    }
    // Path is a direction of travel, which a longer run of positions reads more steadily.
    const wide = putter.filter((s) => s.timestamp >= ti - windows.path.before && s.timestamp <= ti + windows.path.after && s.confidence > 0.2);
    const wt = wide.map((s) => s.timestamp);
    const ww = wide.map((s) => s.confidence);
    const fx = PolyFit.fit(wt, wide.map((s) => s.x), 2, ti, ww);
    const fy = PolyFit.fit(wt, wide.map((s) => s.y), 2, ti, ww);
    if (fx && fy) {
      const v = new Vec2(fx.rate(ti), fy.rate(ti));
      if (v.length > 100) {
        path = { value: degrees(wrapAngle(v.directionAngle - aim)), confidence: conf * clampUnit(v.length / 400) };
      }
      if (faceAtImpactWorld !== null) {
        const centre = new Vec2(fx.value(ti), fy.value(ti));
        const along = Vec2.direction(faceAtImpactWorld).rotated(-Math.PI / 2); // local +x in world
        const sign = handedness === "right" ? 1 : -1;
        strike = { value: ballRest.sub(centre).dot(along) * sign, confidence: conf * 0.8 };
      }
    }
  }
  const faceToPath = face && path ? { value: face.value - path.value, confidence: Math.min(face.confidence, path.confidence) } : null;

  // Start line and speed from the first part of the roll, once clear of the face.
  let start: Measured | null = null;
  let speed: Measured | null = null;
  const clear = roll.filter((s) => {
    const d = ballPosition(s).distance(ballRest);
    return s.timestamp > ti && d >= r * 0.5 && d <= 300;
  });
  if (clear.length >= 4) {
    const pts = clear.map(ballPosition);
    const line = fitLine(pts, clear.map((s) => s.confidence), pts[pts.length - 1].sub(ballRest));
    if (line) {
      const travelled = pts[pts.length - 1].distance(pts[0]);
      const conf = clampUnit(clear.length / 8) * clampUnit(travelled / 60) * clampUnit(line.rms < 0.5 ? 1 : 0.5 / line.rms);
      start = { value: degrees(wrapAngle(line.direction.directionAngle - aim)), confidence: conf };
      const early = clear.filter((s) => ballPosition(s).distance(ballRest) <= 180);
      // A curve, read at impact: a straight line would average away the ball slowing.
      const f =
        early.length >= 3
          ? PolyFit.fit(early.map((s) => s.timestamp), early.map((s) => ballPosition(s).distance(ballRest)), early.length >= 6 ? 2 : 1, ti)
          : null;
      if (f) {
        speed = {
          value: f.rate(ti) / 1000,
          confidence: conf * clampUnit(early.length / 6) * clampUnit(f.rms < 1 ? 1 : 1 / f.rms),
        };
      }
    }
  }

  // The stroke as a whole, in target coordinates.
  const stroke = putter.filter((s) => s.timestamp >= startedAt && s.timestamp <= ti + 0.15 && s.confidence > 0.2);
  const coords = stroke.map((s) => putterPosition(s).sub(ballRest).rotated(aim));
  let lateral: Measured | null = null;
  let backswing: Measured | null = null;
  let rotation: Measured | null = null;
  let backswingTime: number | null = null;
  let downswingTime: number | null = null;
  if (coords.length >= 5) {
    const xs = coords.map((p) => p.x);
    lateral = { value: Math.max(...xs) - Math.min(...xs), confidence: 0.8 };
    const address = stroke.filter((s) => s.timestamp <= startedAt + 0.05);
    if (address.length > 0 && faceAtImpactWorld !== null) {
      const addressFace = address.reduce((a, s) => a + s.faceAngleWorld, 0) / address.length;
      rotation = { value: degrees(wrapAngle(faceAtImpactWorld - addressFace)), confidence: address[0].confidence };
    }
    let top = -1;
    stroke.forEach((s, i) => {
      if (s.timestamp <= ti && (top < 0 || coords[i].y < coords[top].y)) top = i;
    });
    if (top >= 0) {
      backswing = { value: coords[0].y - coords[top].y, confidence: 0.8 };
      backswingTime = stroke[top].timestamp - stroke[0].timestamp;
      downswingTime = ti - stroke[top].timestamp;
    }
  }

  // Gates stand on the aim line through where the ball sat, so they judge the start line alone.
  const gates: GateResult[] = [];
  if (start) {
    for (const g of target.gates) {
      const lateralAt = Math.tan(radians(start.value)) * g.distance;
      gates.push({ gate: g, passed: Math.abs(radians(start.value)) <= gateTolerance(g), lateral: lateralAt });
    }
  }

  const core = [face, path, start].filter((m): m is Measured => m !== null).map((m) => m.confidence);
  return {
    face,
    path,
    faceToPath,
    start,
    ballSpeed: speed,
    strikePoint: strike,
    faceRotation: rotation,
    faceRotationRate: rate,
    lateralMovement: lateral,
    backswingLength: backswing,
    backswingTime,
    downswingTime,
    gates,
    confidence: core.length === 3 ? Math.min(...core) : 0,
  };
}

/** Where the stroke began: the end of the last still moment before impact. */
export function strokeStart(putter: PutterSample[], impact: number, maxLookback = 2.5) {
  const before = putter.filter((s) => s.timestamp <= impact && s.timestamp >= impact - maxLookback);
  let stillSince: number | null = null;
  let lastStillEnd = before[0]?.timestamp ?? impact;
  for (const s of before) {
    if (putterVelocity(s).length < 40) {
      if (stillSince === null) stillSince = s.timestamp;
      if (s.timestamp - stillSince >= 0.12) lastStillEnd = s.timestamp;
    } else {
      stillSince = null;
    }
  }
  return lastStillEnd;
}

export type PuttingSpread = { mean: number; standardDeviation: number; count: number };
export type PuttingConsistency = {
  face: PuttingSpread | null;
  path: PuttingSpread | null;
  faceToPath: PuttingSpread | null;
  start: PuttingSpread | null;
};

/** Repeatability across a set of putts. */
export function consistency(strokes: PuttingStroke[]): PuttingConsistency {
  const spread = (values: number[]): PuttingSpread | null => {
    if (values.length < 2) return null;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const v = values.reduce((a, x) => a + (x - m) ** 2, 0) / (values.length - 1);
    return { mean: m, standardDeviation: Math.sqrt(v), count: values.length };
  };
  const pick = (f: (m: PuttingStrokeMetrics) => Measured | null) =>
    spread(strokes.flatMap((s) => {
      const m = f(s.metrics);
      return m ? [m.value] : [];
    }));
  return { face: pick((m) => m.face), path: pick((m) => m.path), faceToPath: pick((m) => m.faceToPath), start: pick((m) => m.start) };
}

// MARK: validation

/**
 * Measures the lab against printed geometry, so accuracy is a number someone
 * measured rather than a claim. Against the PHYSICAL line: the printed lines
 * do not move when the virtual aim does.
 */
export type ValidationRun = {
  kind: "faceAngle" | "startDirection";
  /** Degrees, positive = right. */
  known: number;
  /** Degrees, measured. */
  readings: number[];
};

export type ValidationSummary = {
  kind: ValidationRun["kind"];
  known: number;
  count: number;
  /** Mean of (measured - known): the bias. */
  meanError: number;
  /** Spread of the readings: the repeatability. */
  standardDeviation: number;
  maxAbsError: number;
};

export function summariseValidation(run: ValidationRun): ValidationSummary {
  const n = run.readings.length;
  const errors = run.readings.map((r) => r - run.known);
  const mean = n ? run.readings.reduce((a, b) => a + b, 0) / n : 0;
  return {
    kind: run.kind,
    known: run.known,
    count: n,
    meanError: n ? errors.reduce((a, b) => a + b, 0) / n : 0,
    standardDeviation: n < 2 ? 0 : Math.sqrt(run.readings.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)),
    maxAbsError: errors.reduce((a, e) => Math.max(a, Math.abs(e)), 0),
  };
}

/** Turns putter samples into one face reading per still hold. */
export class StillHoldDetector {
  holdSeconds = 0.6;
  private window: PutterSample[] = [];
  /** After a reading, the putter must move before the next one counts. */
  private waitingForMove = false;

  add(s: PutterSample): number | null {
    const speed = putterVelocity(s).length;
    const still = speed < 4 && Math.abs(s.angularVelocity) < radians(0.5) && s.confidence > 0.6;
    if (!still) {
      if (speed > 30) this.waitingForMove = false;
      this.window = [];
      return null;
    }
    if (this.waitingForMove) return null;
    this.window.push(s);
    if (s.timestamp - this.window[0].timestamp < this.holdSeconds) return null;
    const reading = this.window.reduce((a, x) => a + x.faceAngleWorld, 0) / this.window.length;
    this.window = [];
    this.waitingForMove = true;
    return degrees(reading);
  }
}
