import { MediaPipePoseProvider, type PoseProviderOptions } from "./mediaPipePoseProvider";
import {
  PoseSwingDetector,
  type PoseSwingDetectorOptions,
  type PoseSwingEvent,
  type PoseSwingSample,
} from "./poseSwingDetector";

export interface PoseSwingCaptureControllerOptions {
  analysisFps?: number;
  provider?: PoseProviderOptions;
  detector?: PoseSwingDetectorOptions;
  onSample?: (sample: PoseSwingSample) => void;
  onEvent?: (event: PoseSwingEvent) => void;
  onError?: (error: Error) => void;
}

/**
 * Runs body-pose inference independently of recording.
 *
 * The camera/video element remains the source of truth. This controller samples
 * it at a modest analysis frame rate so pose detection does not need to run at
 * the camera's full 60/120/240 fps. That keeps capture quality separate from
 * recognition cost and gives us a reusable body-motion layer for future tools.
 */
export class PoseSwingCaptureController {
  private readonly provider: MediaPipePoseProvider;
  private readonly detector: PoseSwingDetector;
  private readonly options: Required<Pick<PoseSwingCaptureControllerOptions, "analysisFps">> &
    Omit<PoseSwingCaptureControllerOptions, "analysisFps">;
  private running = false;
  private rafId: number | null = null;
  private lastAnalysisAt = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    options: PoseSwingCaptureControllerOptions = {}
  ) {
    this.options = { analysisFps: options.analysisFps ?? 15, ...options };
    this.provider = new MediaPipePoseProvider(options.provider);
    this.detector = new PoseSwingDetector(options.detector);
  }

  async start() {
    if (this.running) return;
    await this.provider.initialise();
    this.detector.reset();
    this.running = true;
    this.lastAnalysisAt = 0;
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.detector.reset();
    this.provider.close();
  }

  private tick = () => {
    if (!this.running) return;
    const now = performance.now();
    const intervalMs = 1000 / Math.max(1, this.options.analysisFps);

    if (now - this.lastAnalysisAt >= intervalMs) {
      this.lastAnalysisAt = now;
      try {
        const poseFrame = this.provider.detect(this.video, now);
        if (poseFrame) {
          const sample = this.detector.sample(poseFrame);
          this.options.onSample?.(sample);
          if (sample.event) this.options.onEvent?.(sample.event);
        }
      } catch (error) {
        this.options.onError?.(
          error instanceof Error ? error : new Error("Pose detection failed")
        );
      }
    }

    this.rafId = requestAnimationFrame(this.tick);
  };
}
