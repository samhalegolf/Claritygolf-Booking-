export interface PosePoint {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface PoseFrame {
  timestampMs: number;
  landmarks: PosePoint[];
}

export type PoseSwingState = "searching" | "address" | "swinging" | "settling";

export interface PoseSwingEvent {
  type: "address" | "swing-start" | "swing-finish";
  timestampMs: number;
  confidence: number;
}

export interface PoseSwingSample {
  state: PoseSwingState;
  bodyVisible: boolean;
  motionScore: number;
  event?: PoseSwingEvent;
}

export interface PoseSwingDetectorOptions {
  addressHoldMs?: number;
  settleHoldMs?: number;
  minimumSwingMs?: number;
  visibilityThreshold?: number;
  addressMotionThreshold?: number;
  swingMotionThreshold?: number;
  settleMotionThreshold?: number;
}

const DEFAULTS: Required<PoseSwingDetectorOptions> = {
  addressHoldMs: 700,
  settleHoldMs: 450,
  minimumSwingMs: 450,
  visibilityThreshold: 0.45,
  addressMotionThreshold: 0.018,
  swingMotionThreshold: 0.075,
  settleMotionThreshold: 0.026,
};

// MediaPipe Pose landmark indices used for golf-motion tracking.
const TRACKED = [11, 12, 13, 14, 15, 16, 23, 24];

const distance = (a: PosePoint, b: PosePoint) => Math.hypot(a.x - b.x, a.y - b.y);

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const visible = (point: PosePoint | undefined, threshold: number) =>
  !!point && (point.visibility == null || point.visibility >= threshold);

export class PoseSwingDetector {
  private readonly options: Required<PoseSwingDetectorOptions>;
  private state: PoseSwingState = "searching";
  private previous: PoseFrame | null = null;
  private stableSince: number | null = null;
  private swingStartedAt: number | null = null;
  private settlingSince: number | null = null;

  constructor(options: PoseSwingDetectorOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  reset() {
    this.state = "searching";
    this.previous = null;
    this.stableSince = null;
    this.swingStartedAt = null;
    this.settlingSince = null;
  }

  sample(frame: PoseFrame): PoseSwingSample {
    const bodyVisible = TRACKED.every((index) => visible(frame.landmarks[index], this.options.visibilityThreshold));
    if (!bodyVisible) {
      this.state = "searching";
      this.previous = frame;
      this.stableSince = null;
      this.swingStartedAt = null;
      this.settlingSince = null;
      return { state: this.state, bodyVisible: false, motionScore: 0 };
    }

    const motionScore = this.motion(frame);
    const now = frame.timestampMs;
    let event: PoseSwingEvent | undefined;

    if (this.state === "searching") {
      if (motionScore <= this.options.addressMotionThreshold) {
        this.stableSince ??= now;
        if (now - this.stableSince >= this.options.addressHoldMs) {
          this.state = "address";
          event = { type: "address", timestampMs: now, confidence: this.confidence(motionScore, this.options.addressMotionThreshold, true) };
        }
      } else {
        this.stableSince = null;
      }
    } else if (this.state === "address") {
      if (motionScore >= this.options.swingMotionThreshold) {
        this.state = "swinging";
        this.swingStartedAt = now;
        this.settlingSince = null;
        event = { type: "swing-start", timestampMs: now, confidence: this.confidence(motionScore, this.options.swingMotionThreshold, false) };
      } else if (motionScore > this.options.addressMotionThreshold * 2) {
        // The player walked away or substantially changed pose; require a new stable address.
        this.state = "searching";
        this.stableSince = null;
      }
    } else if (this.state === "swinging") {
      if ((this.swingStartedAt == null || now - this.swingStartedAt >= this.options.minimumSwingMs) && motionScore <= this.options.settleMotionThreshold) {
        this.state = "settling";
        this.settlingSince = now;
      }
    } else if (this.state === "settling") {
      if (motionScore > this.options.settleMotionThreshold) {
        this.state = "swinging";
        this.settlingSince = null;
      } else if (this.settlingSince != null && now - this.settlingSince >= this.options.settleHoldMs) {
        this.state = "searching";
        event = { type: "swing-finish", timestampMs: now, confidence: this.confidence(motionScore, this.options.settleMotionThreshold, true) };
        this.stableSince = null;
        this.swingStartedAt = null;
        this.settlingSince = null;
      }
    }

    this.previous = frame;
    return { state: this.state, bodyVisible: true, motionScore, event };
  }

  private motion(frame: PoseFrame) {
    if (!this.previous) return 0;
    const dt = Math.max(16, frame.timestampMs - this.previous.timestampMs) / 1000;
    const jointSpeeds = TRACKED.map((index) => {
      const current = frame.landmarks[index];
      const previous = this.previous!.landmarks[index];
      return current && previous ? distance(current, previous) / dt : 0;
    });

    // Hands are deliberately weighted: a golf swing creates a pronounced wrist-speed spike.
    const wristSpeed = average([jointSpeeds[4], jointSpeeds[5]]);
    const torsoSpeed = average([jointSpeeds[0], jointSpeeds[1], jointSpeeds[6], jointSpeeds[7]]);
    return wristSpeed * 0.7 + torsoSpeed * 0.3;
  }

  private confidence(value: number, threshold: number, belowThreshold: boolean) {
    const ratio = belowThreshold ? threshold / Math.max(value, threshold * 0.15) : value / Math.max(threshold, 0.0001);
    return Math.max(0.5, Math.min(0.99, 0.5 + Math.abs(ratio - 1) * 0.2));
  }
}
