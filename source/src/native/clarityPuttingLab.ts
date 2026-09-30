// The Clarity Putting Lab, as the page sees it.
//
// The lab is native (native/clarity-putting-lab): the camera, tracking and the
// live gate screen all run on the phone, because they have to keep up with
// 120-240 frames a second. It exists only inside the Clarity Booking staff app
// (booking-app/), which injects window.Capacitor. In a browser
// nativePuttingLab() returns null and nothing about the lab is shown.
//
// Read off window rather than imported from @capacitor/core, like the Tap to
// Pay bridge (clarityTerminal.ts): the web bundle carries no Capacitor code.
//
// Units in a stroke:
//   - metrics: degrees against the aim line, positive = right; face-to-path is
//     face minus path; ballSpeed m/s; strikePoint mm, positive = toward the toe.
//   - samples: WORLD coordinates, millimetres, with the calibrated ball at the
//     origin and +y down the physical calibration line. faceAngleWorld is in
//     RADIANS against that line, positive = right. Stored this way so a putt
//     can be re-read against any aim later.

export type PuttingMeasured = { value: number; confidence: number };

export type PuttingGate = { distance: number; width: number };

export type PuttingStrokeMetrics = {
  face?: PuttingMeasured;
  path?: PuttingMeasured;
  faceToPath?: PuttingMeasured;
  start?: PuttingMeasured;
  ballSpeed?: PuttingMeasured;
  strikePoint?: PuttingMeasured;
  faceRotation?: PuttingMeasured;
  faceRotationRate?: PuttingMeasured;
  lateralMovement?: PuttingMeasured;
  backswingLength?: PuttingMeasured;
  backswingTime?: number;
  downswingTime?: number;
  gates: Array<{ gate: PuttingGate; passed: boolean; lateral: number }>;
  confidence: number;
};

export type PutterSample = {
  timestamp: number;
  x: number;
  y: number;
  faceAngleWorld: number;
  velocityX: number;
  velocityY: number;
  angularVelocity: number;
  confidence: number;
  sources: Array<"markers" | "features" | "edge" | "reacquire">;
};

export type BallSample = {
  timestamp: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  radiusMM: number;
  confidence: number;
  dots: Array<{ x: number; y: number }>;
};

export type PuttingStroke = {
  id: string;
  startedAt: number;
  impact: { time: number; fromBall?: number; fromPutter?: number; confidence: number };
  ballRest: { x: number; y: number };
  putterSamples: PutterSample[];
  ballSamples: BallSample[];
  trackingMode: "markerless" | "enhanced";
  handedness: "right" | "left";
  /** aimOffset in radians, positive = right. */
  target: { aimOffset: number; gates: PuttingGate[] };
  metrics: PuttingStrokeMetrics;
};

export type PuttingSpread = { mean: number; standardDeviation: number; count: number };

export type PuttingConsistency = {
  face?: PuttingSpread;
  path?: PuttingSpread;
  faceToPath?: PuttingSpread;
  start?: PuttingSpread;
};

export type PuttingValidationSummary = {
  kind: "faceAngle" | "startDirection";
  known: number;
  count: number;
  meanError: number;
  standardDeviation: number;
  maxAbsError: number;
};

export type PuttingLabPhase =
  | "findingTemplate"
  | "placingBall"
  | "placingPutter"
  | "removeTemplate"
  | "live"
  | "cameraMoved";

type Listener = { remove: () => Promise<void> | void };

export type ClarityPuttingLabPlugin = {
  isSupported(): Promise<{ supported: boolean; maxFrameRate: number; reason: string }>;
  open(options?: {
    /** Virtual aim in degrees, positive = right of the calibration line. */
    aimDegrees?: number;
    handedness?: "right" | "left";
    gates?: PuttingGate[];
    /** Start with the developer overlay on. */
    debug?: boolean;
  }): Promise<{ opened: boolean }>;
  close(): Promise<{ closed: boolean }>;
  addListener(event: "strokeMeasured", handler: (data: { stroke: PuttingStroke }) => void): Promise<Listener> | Listener;
  addListener(event: "phaseChanged", handler: (data: { phase: PuttingLabPhase }) => void): Promise<Listener> | Listener;
  addListener(
    event: "validationFinished",
    handler: (data: { summary: PuttingValidationSummary }) => void,
  ): Promise<Listener> | Listener;
  addListener(
    event: "closed",
    handler: (data: { strokes: PuttingStroke[]; consistency: PuttingConsistency }) => void,
  ): Promise<Listener> | Listener;
};

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, unknown>;
};

/**
 * The printable A3 calibration template. Generated from the same layout the
 * lab detects (native/clarity-putting-lab, CalibrationTemplate.swift); a core
 * test fails if this file and that layout ever disagree.
 */
export const PUTTING_LAB_TEMPLATE_URL = "https://claritygolf.app/putting-lab/calibration-template-a3.svg";

/** The plugin when running inside the staff app, otherwise null. */
export function nativePuttingLab(): ClarityPuttingLabPlugin | null {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.() || !capacitor.isPluginAvailable?.("ClarityPuttingLab")) return null;
  return (capacitor.Plugins?.ClarityPuttingLab as ClarityPuttingLabPlugin | undefined) || null;
}
