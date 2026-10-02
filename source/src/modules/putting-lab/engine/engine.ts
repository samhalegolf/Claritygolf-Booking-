// The Putting Lab, minus the camera and the screen: feed it luma frames, read
// snapshots. Owns calibration, both trackers, impact detection and the putts.
// Not thread-safe; in the browser it lives in one worker.
//
// It says nothing in English: prompts and warnings are codes, which the page
// turns into the reader's language.

import { BallTracker, type BallSample, type BallStatus } from "./ball";
import { PuttingCoordinateSystem, type PracticeTarget, type SurfaceCalibration } from "./coordinates";
import { degrees, homographyRMS, inverse3, localScale, normalized3, solveHomography, Vec2, apply3, clampUnit } from "./geometry";
import { IntRect, meanIn, type LumaPlane } from "./luma";
import {
  CameraMovementTracker,
  cameraLevel,
  cameraTilt,
  type CameraLevel,
  type CameraMovement,
  type DeviceAttitude,
} from "./motion";
import { PutterCalibrator, trackingMode, type Handedness, type PutterCalibration, type PutterSource, type PutterTrackingMode } from "./putter";
import {
  analyseStroke,
  consistency,
  estimateImpact,
  StillHoldDetector,
  strokeStart,
  summariseValidation,
  type PuttingConsistency,
  type PuttingStroke,
  type ValidationRun,
  type ValidationSummary,
} from "./stroke";
import { BALL_DIAMETER_MM, TEMPLATE, TEMPLATE_DISC_RADIUS, TemplateDetector, type TemplateDetection } from "./template";
import { PutterTracker, type PutterSample, type PutterStatus } from "./tracker";

export type Point = { x: number; y: number };

export type PuttingLabPhase = "findingTemplate" | "placingBall" | "placingPutter" | "removeTemplate" | "live" | "cameraMoved";
export type PuttingGateState = "waitingForBall" | "ready" | "inStroke" | "showingResult";

export type PromptCode =
  | "tiltedTooFar"
  | "layTemplate"
  | "layTemplateTilted"
  | "templateHold"
  | "placeBall"
  | "centreBall"
  | "placePutter"
  | "holdPutter"
  | "putterNotOnLine"
  | "faceTooNarrow"
  | "noEdge"
  | "calibrated"
  | "cameraMoved"
  | "placeBallOnSpot"
  | "ready"
  | "readyNoPutter"
  | "inStroke"
  | "result";

export type WarningCode = "cameraNudged" | "ballScale";

/** What the screen needs, once per frame. Plain data, so it crosses from the worker. */
export type PuttingLabSnapshot = {
  timestamp: number;
  phase: PuttingLabPhase;
  gate: PuttingGateState;
  prompt: PromptCode;
  /** Number for a prompt or warning that carries one (mm off centre, measured ball size). */
  promptValue: number | null;
  warning: WarningCode | null;
  warningValue: number | null;

  surface: SurfaceCalibration | null;
  target: PracticeTarget;
  templatePoints: Point[];
  templateStableFrames: number;

  ball: BallSample | null;
  ballStatus: BallStatus;
  ballRest: Point | null;
  ballSearch: { center: Point; radius: number } | null;

  putter: PutterSample | null;
  putterStatus: PutterStatus;
  putterShape: { faceHalfWidth: number; handedness: Handedness } | null;
  trackingMode: PutterTrackingMode | null;
  sourcePoints: Partial<Record<PutterSource, Point[]>>;
  sourceConfidence: Partial<Record<PutterSource, number>>;

  /** The live stroke while one is under way, else the last putt's. */
  trace: PutterSample[];
  ballTrace: BallSample[];
  lastStroke: PuttingStroke | null;
  strokeCount: number;
  consistency: PuttingConsistency | null;

  level: CameraLevel | null;
  movement: CameraMovement | null;
  cameraTiltDegrees: number | null;
  validation: ValidationSummary | null;

  inputFPS: number;
  processingMilliseconds: number;
};

export type PuttingLabConfiguration = {
  handedness: Handedness;
  target: PracticeTarget;
  /** How long a result stays on screen before the gate re-arms. */
  resultHoldSeconds: number;
  /** A ball that travels less than this was nudged, not putted. */
  minimumPuttTravel: number;
};

export const defaultConfiguration = (): PuttingLabConfiguration => ({
  handedness: "right",
  target: { aimOffset: 0, gates: [] },
  resultHoldSeconds: 2.5,
  minimumPuttTravel: 60,
});

function emptySnapshot(target: PracticeTarget): PuttingLabSnapshot {
  return {
    timestamp: 0,
    phase: "findingTemplate",
    gate: "waitingForBall",
    prompt: "layTemplate",
    promptValue: null,
    warning: null,
    warningValue: null,
    surface: null,
    target,
    templatePoints: [],
    templateStableFrames: 0,
    ball: null,
    ballStatus: "absent",
    ballRest: null,
    ballSearch: null,
    putter: null,
    putterStatus: "lost",
    putterShape: null,
    trackingMode: null,
    sourcePoints: {},
    sourceConfidence: {},
    trace: [],
    ballTrace: [],
    lastStroke: null,
    strokeCount: 0,
    consistency: null,
    level: null,
    movement: null,
    cameraTiltDegrees: null,
    validation: null,
    inputFPS: 0,
    processingMilliseconds: 0,
  };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class PuttingLabEngine {
  configuration: PuttingLabConfiguration;
  phase: PuttingLabPhase = "findingTemplate";
  strokes: PuttingStroke[] = [];
  snapshot: PuttingLabSnapshot;
  onStroke?: (stroke: PuttingStroke) => void;

  private templateDetector = new TemplateDetector();
  private putterCalibrator = new PutterCalibrator();
  private surface: SurfaceCalibration | null = null;
  private coordinates: PuttingCoordinateSystem | null = null;
  private ballTracker: BallTracker | null = null;
  private putterTracker: PutterTracker | null = null;
  private putterCalibration: PutterCalibration | null = null;

  private stableDetections: TemplateDetection[] = [];
  private lastTemplateCheck = -Infinity;
  private templateMissing = 0;
  private putterOnLineSince: number | null = null;
  private putterRegionMean: number | null = null;
  private ballScaleWarning: number | null = null;

  private gate: PuttingGateState = "waitingForBall";
  private putterHistory: PutterSample[] = [];
  private departureTime: number | null = null;
  private resultUntil = 0;
  private liveTrace: PutterSample[] = [];

  private validationRun: ValidationRun | null = null;
  private stillHold = new StillHoldDetector();
  private lastAttitude: DeviceAttitude | null = null;
  private movementTracker: CameraMovementTracker | null = null;
  private frameTimes: number[] = [];

  constructor(configuration: PuttingLabConfiguration = defaultConfiguration()) {
    this.configuration = configuration;
    this.snapshot = emptySnapshot(configuration.target);
  }

  // MARK: controls

  /** Throw away all calibration and start again from the template. */
  recalibrate() {
    this.surface = null;
    this.movementTracker = null;
    this.coordinates = null;
    this.ballTracker = null;
    this.putterTracker = null;
    this.putterCalibration = null;
    this.stableDetections = [];
    this.putterOnLineSince = null;
    this.putterRegionMean = null;
    this.ballScaleWarning = null;
    this.putterHistory = [];
    this.liveTrace = [];
    this.gate = "waitingForBall";
    this.departureTime = null;
    this.phase = "findingTemplate";
  }

  /** Skip waiting for the template to be lifted (practise with it down). */
  startLive() {
    if (this.phase === "removeTemplate") this.goLive();
  }

  /** Swing the virtual aim about the ball. Nothing is recalibrated; every putt is re-read. */
  setTarget(target: PracticeTarget) {
    this.configuration.target = target;
    if (this.coordinates) this.coordinates.target = target;
    this.strokes = this.strokes.map((s) => ({
      ...s,
      target,
      metrics: analyseStroke(s.putterSamples, s.ballSamples, new Vec2(s.ballRest.x, s.ballRest.y), s.impact, target, s.handedness, s.startedAt),
    }));
    this.snapshot.target = target;
    this.snapshot.lastStroke = this.strokes[this.strokes.length - 1] ?? null;
    this.snapshot.consistency = consistency(this.strokes);
  }

  setHandedness(handedness: Handedness) {
    this.configuration.handedness = handedness;
  }

  beginValidation(kind: ValidationRun["kind"], known: number) {
    this.validationRun = { kind, known, readings: [] };
    this.stillHold = new StillHoldDetector();
  }

  endValidation(): ValidationRun | null {
    const run = this.validationRun;
    this.validationRun = null;
    this.snapshot.validation = null;
    return run;
  }

  // MARK: frames

  process(plane: LumaPlane, t: number, attitude: DeviceAttitude | null = null): PuttingLabSnapshot {
    const started = now();
    this.frameTimes.push(t);
    this.frameTimes = this.frameTimes.filter((x) => x >= t - 1);
    if (attitude) this.lastAttitude = attitude;

    const s = this.snapshot;
    s.timestamp = t;
    s.warning = null;
    s.warningValue = null;
    s.promptValue = null;
    s.sourcePoints = {};
    s.sourceConfidence = {};
    if (attitude) {
      s.level = cameraLevel(attitude);
      s.cameraTiltDegrees = degrees(cameraTilt(attitude));
      if (this.movementTracker) {
        const movement = this.movementTracker.update(attitude, t);
        s.movement = movement;
        if (movement === "moved" && this.phase !== "findingTemplate" && this.phase !== "cameraMoved") {
          this.phase = "cameraMoved";
        } else if (movement === "nudged") {
          s.warning = "cameraNudged";
        }
      }
    }

    switch (this.phase) {
      case "findingTemplate":
        this.stepFindTemplate(plane, t);
        break;
      case "placingBall":
        this.stepPlaceBall(plane, t);
        break;
      case "placingPutter":
        this.stepPlacePutter(plane, t);
        break;
      case "removeTemplate":
        this.stepRemoveTemplate(plane, t);
        break;
      case "live":
        this.stepLive(plane, t);
        break;
      case "cameraMoved":
        s.prompt = "cameraMoved";
        break;
    }

    s.phase = this.phase;
    s.gate = this.gate;
    s.surface = this.surface;
    s.target = this.configuration.target;
    s.putterShape = this.putterCalibration
      ? { faceHalfWidth: this.putterCalibration.faceHalfWidth, handedness: this.putterCalibration.handedness }
      : null;
    s.trackingMode = this.putterCalibration ? trackingMode(this.putterCalibration) : null;
    s.validation = this.validationRun ? summariseValidation(this.validationRun) : null;
    const first = this.frameTimes[0];
    if (first !== undefined && t > first) s.inputFPS = (this.frameTimes.length - 1) / (t - first);
    s.processingMilliseconds = now() - started;
    return s;
  }

  // MARK: calibration

  private stepFindTemplate(plane: LumaPlane, t: number) {
    const s = this.snapshot;
    if (s.level === "tooSteep") {
      s.prompt = "tiltedTooFar";
      this.stableDetections = [];
      return;
    }
    s.prompt = s.level === "tilted" ? "layTemplateTilted" : "layTemplate";
    // Whole-frame search, so throttled.
    if (t - this.lastTemplateCheck < 1 / 12) {
      if (this.stableDetections.length > 0) s.prompt = "templateHold";
      return;
    }
    this.lastTemplateCheck = t;
    const d = this.templateDetector.detect(plane);
    if (!d) {
      this.stableDetections = [];
      s.templatePoints = [];
      s.templateStableFrames = 0;
      return;
    }
    const previous = this.stableDetections[this.stableDetections.length - 1];
    if (previous) {
      const moved = Math.max(...previous.imagePoints.map((p, i) => p.distance(d.imagePoints[i])));
      if (moved > 0.8) this.stableDetections = [];
    }
    this.stableDetections.push(d);
    s.templatePoints = d.imagePoints;
    s.templateStableFrames = this.stableDetections.length;
    s.prompt = "templateHold";
    if (this.stableDetections.length < 6) return;

    // Average the steady sightings, then solve once.
    const n = this.stableDetections.length;
    const image = d.imagePoints.map((_, i) =>
      this.stableDetections.reduce((a, det) => a.add(det.imagePoints[i].div(n)), Vec2.zero),
    );
    const h = solveHomography(image, d.worldPoints);
    const inverse = h ? inverse3(h) : null;
    const ballPixel = inverse ? apply3(inverse, Vec2.zero) : null;
    const scale = h && ballPixel ? localScale(h, ballPixel) : null;
    if (!h || !inverse || !ballPixel || !scale) {
      this.stableDetections = [];
      return;
    }
    const rms = homographyRMS(h, image, d.worldPoints);
    this.surface = {
      imageToWorld: h,
      worldToImage: normalized3(inverse),
      imageWidth: plane.width,
      imageHeight: plane.height,
      ballOrigin: Vec2.zero,
      mmPerPixelAtBall: scale,
      reprojectionErrorMM: rms,
      referenceCount: image.length,
      confidence: clampUnit(1 - rms / 2),
      attitude: this.lastAttitude,
      timestamp: t,
    };
    this.movementTracker = this.lastAttitude ? new CameraMovementTracker(this.lastAttitude, t) : null;
    this.coordinates = new PuttingCoordinateSystem(this.surface, this.configuration.target);
    this.ballTracker = new BallTracker(this.coordinates);
    // A millimetre in from the rim, clear of the edge where ink meets paper.
    this.ballTracker.disc = TEMPLATE_DISC_RADIUS - 1;
    this.stableDetections = [];
    this.phase = "placingBall";
  }

  private stepPlaceBall(plane: LumaPlane, t: number) {
    const ball = this.ballTracker;
    if (!ball) return;
    const s = this.snapshot;
    ball.update(plane, t);
    s.ball = ball.last;
    s.ballStatus = ball.status;
    s.ballSearch = ball.lastSearch;
    s.prompt = "placeBall";
    if (ball.offCentre !== null) {
      s.prompt = "centreBall";
      s.promptValue = Math.round(ball.offCentre);
      return;
    }
    // Seen whole inside the disc, so already within a few millimetres of its centre.
    const rest = ball.restPosition;
    if (ball.status !== "atRest" || !rest || !ball.last) return;
    // The ball is a known size: a second check on the solve and the print scale.
    const diameter = ball.last.radiusMM * 2;
    if (Math.abs(diameter / BALL_DIAMETER_MM - 1) > 0.1) this.ballScaleWarning = diameter;
    s.ballRest = rest;
    this.phase = "placingPutter";
  }

  private applyScaleWarning() {
    if (this.ballScaleWarning !== null && !this.snapshot.warning) {
      this.snapshot.warning = "ballScale";
      this.snapshot.warningValue = Math.round(this.ballScaleWarning * 10) / 10;
    }
  }

  private stepPlacePutter(plane: LumaPlane, t: number) {
    const c = this.coordinates;
    if (!c) return;
    const s = this.snapshot;
    s.prompt = "placePutter";
    this.applyScaleWarning();
    if (this.putterCalibrator.lineCoverage(plane, c) <= 0.35) {
      this.putterOnLineSince = null;
      this.putterRegionMean = null;
      return;
    }
    // Still: the region behind the line has stopped changing.
    const corners = [new Vec2(-90, TEMPLATE.faceLineY - 60), new Vec2(90, TEMPLATE.faceLineY + 2)].flatMap((p) => {
      const q = c.imageFromWorld(p);
      return q ? [q] : [];
    });
    const mean = meanIn(plane, IntRect.covering(corners, 0));
    if (this.putterRegionMean !== null && Math.abs(mean - this.putterRegionMean) > 1.5) this.putterOnLineSince = null;
    this.putterRegionMean = mean;
    if (this.putterOnLineSince === null) this.putterOnLineSince = t;
    if (t - this.putterOnLineSince < 0.6) {
      s.prompt = "holdPutter";
      return;
    }
    const result = this.putterCalibrator.calibrate(plane, c, this.configuration.handedness, t);
    if (!result.ok) {
      this.putterOnLineSince = null;
      s.prompt = result.error;
      return;
    }
    this.putterCalibration = result.calibration;
    this.putterTracker = new PutterTracker(result.calibration, c);
    this.putterTracker.seed(result.calibration.pose, t);
    this.templateMissing = 0;
    this.phase = "removeTemplate";
  }

  private stepRemoveTemplate(plane: LumaPlane, t: number) {
    this.snapshot.prompt = "calibrated";
    this.applyScaleWarning();
    if (t - this.lastTemplateCheck < 1 / 4) return;
    this.lastTemplateCheck = t;
    if (this.templateDetector.detect(plane) === null) {
      this.templateMissing++;
      if (this.templateMissing >= 3) this.goLive();
    } else {
      this.templateMissing = 0;
    }
  }

  private goLive() {
    if (this.ballTracker) this.ballTracker.disc = null;
    this.ballTracker?.rearm();
    this.putterTracker?.reset();
    this.gate = "waitingForBall";
    this.phase = "live";
  }

  // MARK: live

  private stepLive(plane: LumaPlane, t: number) {
    const ball = this.ballTracker;
    const putter = this.putterTracker;
    if (!ball || !putter) return;
    const s = this.snapshot;
    const ballSample = ball.update(plane, t);
    const address = ball.restPosition ?? this.surface?.ballOrigin ?? Vec2.zero;
    const putterSample = putter.update(plane, t, address);
    if (putterSample) {
      this.putterHistory.push(putterSample);
      if (this.gate !== "showingResult") this.liveTrace.push(putterSample);
    }
    this.putterHistory = this.putterHistory.filter((p) => p.timestamp >= t - 3);
    this.liveTrace = this.liveTrace.filter((p) => p.timestamp >= t - 3);

    if (this.validationRun?.kind === "faceAngle" && putterSample) {
      const reading = this.stillHold.add(putterSample);
      if (reading !== null) this.validationRun.readings.push(reading);
    }

    switch (this.gate) {
      case "showingResult":
        if (t >= this.resultUntil) {
          ball.rearm();
          this.liveTrace = [];
          this.gate = "waitingForBall";
        }
        break;
      case "waitingForBall":
      case "ready":
        if (ball.status === "rolling") {
          this.departureTime = t;
          this.gate = "inStroke";
        } else {
          this.gate = ball.status === "atRest" ? "ready" : "waitingForBall";
          if (this.gate === "waitingForBall") this.liveTrace = [];
        }
        break;
      case "inStroke": {
        const rest = ball.restPosition ?? address;
        const travelled = ball.last ? new Vec2(ball.last.x, ball.last.y).distance(rest) : 0;
        const elapsed = t - (this.departureTime ?? t);
        if (ball.status === "finished" || elapsed >= 0.45) {
          if (travelled >= this.configuration.minimumPuttTravel) {
            this.finishStroke(ball, rest, t);
          } else {
            // A nudge at address, or the ball picked up: not a putt.
            ball.rearm();
            this.gate = "waitingForBall";
          }
        }
        break;
      }
    }

    s.ball = ballSample ?? ball.last;
    s.ballStatus = ball.status;
    s.ballRest = ball.restPosition;
    s.ballSearch = ball.lastSearch;
    s.putter = putterSample;
    s.putterStatus = putter.status;
    for (const o of putter.lastObservations) {
      s.sourcePoints[o.source] = o.debugPoints;
      s.sourceConfidence[o.source] = o.confidence;
    }
    if (this.gate !== "showingResult") {
      s.trace = this.liveTrace.slice();
      s.ballTrace = this.gate === "inStroke" ? ball.roll.slice() : [];
    }
    s.prompt =
      this.gate === "waitingForBall"
        ? "placeBallOnSpot"
        : this.gate === "ready"
          ? putter.status === "tracking"
            ? "ready"
            : "readyNoPutter"
          : this.gate === "inStroke"
            ? "inStroke"
            : "result";
  }

  private finishStroke(ball: BallTracker, rest: Vec2, t: number) {
    const roll = ball.roll.slice();
    const impact = estimateImpact(rest, roll, this.putterHistory);
    if (!impact) {
      ball.rearm();
      this.gate = "waitingForBall";
      return;
    }
    const startedAt = strokeStart(this.putterHistory, impact.time);
    const samples = this.putterHistory.filter((p) => p.timestamp >= startedAt - 0.1 && p.timestamp <= impact.time + 0.5);
    const cfg = this.configuration;
    const stroke: PuttingStroke = {
      id: newId(),
      startedAt,
      impact,
      ballRest: { x: rest.x, y: rest.y },
      putterSamples: samples,
      ballSamples: roll,
      trackingMode: this.putterCalibration ? trackingMode(this.putterCalibration) : "markerless",
      handedness: cfg.handedness,
      target: cfg.target,
      metrics: analyseStroke(samples, roll, rest, impact, cfg.target, cfg.handedness, startedAt),
    };
    this.strokes.push(stroke);
    if (this.validationRun?.kind === "startDirection" && stroke.metrics.start) {
      // Validation is against the physical line: undo the aim.
      this.validationRun.readings.push(stroke.metrics.start.value + degrees(cfg.target.aimOffset));
    }
    const s = this.snapshot;
    s.lastStroke = stroke;
    s.strokeCount = this.strokes.length;
    s.consistency = consistency(this.strokes);
    s.trace = samples;
    s.ballTrace = roll;
    this.gate = "showingResult";
    this.resultUntil = t + cfg.resultHoldSeconds;
    this.onStroke?.(stroke);
  }
}
