import { DrawingObject } from "../models/Drawing";

// Recording the analysis view means redrawing what the coach sees onto a
// canvas: the current video frame, then the drawing objects on top. We redraw
// the objects with Canvas2D rather than rasterising the SVG overlay each frame,
// which keeps the loop cheap enough to hold frame rate on long recordings.

const RECORDING_FRAME_RATE = 30;
const MAX_RECORDING_WIDTH = 1280;
const RECORDER_TIMESLICE_MS = 250;

export interface AnalysisRecorderFrame {
  video: HTMLVideoElement | null;
  objects: DrawingObject[];
  /** Display size of the overlay, used to scale stroke widths to the canvas. */
  overlay: { width: number; height: number };
}

export interface AnalysisRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  width: number;
  height: number;
}

export const getPreferredRecordingMimeType = () => {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return (
    [
      "video/mp4;codecs=h264",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ""
  );
};

const recordingTimestamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").replace("Z", "");

export const getRecordingFileName = (label: string, mimeType: string) => {
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  return `${label}-${recordingTimestamp()}.${extension}`;
};

const drawObject = (
  ctx: CanvasRenderingContext2D,
  object: DrawingObject,
  width: number,
  height: number,
  strokeScale: number
) => {
  ctx.save();
  ctx.strokeStyle = object.color;
  ctx.globalAlpha = object.opacity;
  ctx.lineWidth = Math.max(1, object.strokeWidth * strokeScale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (object.type === "line") {
    ctx.beginPath();
    ctx.moveTo(object.x1 * width, object.y1 * height);
    ctx.lineTo(object.x2 * width, object.y2 * height);
    ctx.stroke();
  } else if (object.type === "angle") {
    ctx.beginPath();
    ctx.moveTo(object.x2 * width, object.y2 * height);
    ctx.lineTo(object.x1 * width, object.y1 * height);
    ctx.lineTo(object.x3 * width, object.y3 * height);
    ctx.stroke();
  } else if (object.type === "circle") {
    const cx = object.cx * width;
    const cy = object.cy * height;
    const rx = Math.max(0.5, object.rx * width);
    const ry = Math.max(0.5, object.ry * height);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    // The faint centre guides are part of how a circle reads on screen, so the
    // recording keeps them.
    ctx.save();
    ctx.lineWidth = Math.max(1, 0.9 * strokeScale);
    ctx.setLineDash([3 * strokeScale, 3 * strokeScale]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + rx, cy);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + ry);
    ctx.stroke();
    ctx.restore();
  } else if (object.points.length) {
    ctx.beginPath();
    object.points.forEach((point, index) => {
      const x = point.x * width;
      const y = point.y * height;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  ctx.restore();
};

export class AnalysisViewRecorder {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frameHandle = 0;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private micStream: MediaStream | null = null;
  private canvasStream: MediaStream | null = null;
  private startedAt = 0;
  private mimeType = "";
  private pending: Promise<AnalysisRecording> | null = null;

  constructor(private readonly getFrame: () => AnalysisRecorderFrame) {}

  get isRecording() {
    return this.recorder?.state === "recording";
  }

  async start(): Promise<void> {
    if (this.recorder) {
      throw new Error("A recording is already running.");
    }
    if (typeof MediaRecorder === "undefined") {
      throw new Error("Recording is not supported in this browser.");
    }
    const { video } = this.getFrame();
    if (!video) {
      throw new Error("Load a video before recording.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is not available in this browser.");
    }

    const sourceWidth = video.videoWidth || video.clientWidth || 1280;
    const sourceHeight = video.videoHeight || video.clientHeight || 720;
    const scale = Math.min(1, MAX_RECORDING_WIDTH / sourceWidth);
    // Even dimensions keep H.264 encoders happy.
    const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
    const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not prepare the recording canvas.");
    }

    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error("Microphone permission is needed to record commentary.");
    }

    try {
      const canvasStream = canvas.captureStream(RECORDING_FRAME_RATE);
      const stream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...micStream.getAudioTracks(),
      ]);
      const mimeType = getPreferredRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      this.canvas = canvas;
      this.ctx = ctx;
      this.micStream = micStream;
      this.canvasStream = canvasStream;
      this.recorder = recorder;
      this.mimeType = mimeType;
      this.chunks = [];

      this.pending = new Promise<AnalysisRecording>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) this.chunks.push(event.data);
        };
        recorder.onerror = () => {
          this.teardown();
          reject(new Error("Recording failed."));
        };
        recorder.onstop = () => {
          const durationMs = Date.now() - this.startedAt;
          const blobType =
            this.mimeType || this.chunks.find((chunk) => chunk.type)?.type || "video/webm";
          const blob = new Blob(this.chunks, { type: blobType });
          this.teardown();
          if (!blob.size) {
            reject(new Error("Recording did not capture any video."));
            return;
          }
          resolve({ blob, mimeType: blob.type || blobType, durationMs, width, height });
        };
      });

      this.startedAt = Date.now();
      this.frameHandle = requestAnimationFrame(this.renderLoop);
      recorder.start(RECORDER_TIMESLICE_MS);
    } catch (error) {
      micStream.getTracks().forEach((track) => track.stop());
      this.teardown();
      throw error instanceof Error ? error : new Error("Could not start recording.");
    }
  }

  stop(): Promise<AnalysisRecording> {
    const recorder = this.recorder;
    const pending = this.pending;
    if (!recorder || !pending) {
      return Promise.reject(new Error("No recording is running."));
    }
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    return pending;
  }

  cancel() {
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    this.teardown();
  }

  private renderLoop = () => {
    this.frameHandle = requestAnimationFrame(this.renderLoop);
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const { video, objects, overlay } = this.getFrame();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (video && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    const strokeScale = overlay.width > 0 ? canvas.width / overlay.width : 1;
    objects.forEach((object) => drawObject(ctx, object, canvas.width, canvas.height, strokeScale));
  };

  private teardown() {
    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = 0;
    }
    this.canvasStream?.getTracks().forEach((track) => track.stop());
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.canvasStream = null;
    this.micStream = null;
    this.recorder = null;
    this.canvas = null;
    this.ctx = null;
    this.chunks = [];
    this.pending = null;
  }
}
