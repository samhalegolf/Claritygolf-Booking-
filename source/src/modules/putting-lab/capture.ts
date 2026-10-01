// The phone's camera and motion sensors, as the Putting Lab needs them.
//
// The camera is asked for its rear lens at up to 60 frames a second; browsers
// give what they can (often 30, sometimes 60). Frames go to the engine worker
// one at a time, and a frame that arrives while the worker is busy is
// skipped: latency matters more than completeness.

import type { DeviceAttitude } from "./engine/motion";
import { quaternionFromEuler } from "./engine/motion";
import type { WorkerRequest, WorkerResponse } from "./engine.worker";

/** Frames wider than this are scaled down first: finer than the lab needs, and slower. */
const MAX_WIDTH = 1280;

export type CameraInfo = { width: number; height: number; frameRate: number | null };

export async function openRearCamera(): Promise<{ stream: MediaStream; info: CameraInfo }> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60 },
    },
  });
  const settings = stream.getVideoTracks()[0]?.getSettings() ?? {};
  return {
    stream,
    info: { width: settings.width ?? 0, height: settings.height ?? 0, frameRate: settings.frameRate ?? null },
  };
}

type PermissionRequester = { requestPermission?: () => Promise<"granted" | "denied"> };

/**
 * Device orientation and gravity. iOS asks permission, and only inside a tap,
 * so call this from the button that starts the lab. Without it the lab still
 * measures; it just cannot warn about tilt or a knocked camera.
 */
export async function startMotion(): Promise<{ read: () => DeviceAttitude | null; stop: () => void }> {
  for (const api of [globalThis.DeviceOrientationEvent, globalThis.DeviceMotionEvent] as unknown as PermissionRequester[]) {
    try {
      if (api?.requestPermission) await api.requestPermission();
    } catch {
      // Refused or unavailable: carry on without motion.
    }
  }
  let quaternion: { w: number; x: number; y: number; z: number } | null = null;
  let gravity: { x: number; y: number; z: number } | null = null;
  const onOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    quaternion = quaternionFromEuler(e.alpha, e.beta, e.gamma);
  };
  const onMotion = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (g?.x == null || g.y == null || g.z == null) return;
    gravity = { x: g.x, y: g.y, z: g.z };
  };
  window.addEventListener("deviceorientation", onOrientation);
  window.addEventListener("devicemotion", onMotion);
  return {
    read: () => (quaternion && gravity ? { ...(quaternion as { w: number; x: number; y: number; z: number }), gravity } : null),
    stop: () => {
      window.removeEventListener("deviceorientation", onOrientation);
      window.removeEventListener("devicemotion", onMotion);
    },
  };
}

type FrameMetadata = { mediaTime: number; captureTime?: number };
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Pump frames from the video into the worker. Returns a stop function.
 * `processedSize` is the frame size the engine sees (after any downscale).
 */
export function pumpFrames(
  video: HTMLVideoElement,
  worker: Worker,
  readAttitude: () => DeviceAttitude | null,
  onSize: (width: number, height: number) => void,
) {
  const v = video as VideoWithFrameCallback;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let busy = false;
  let stopped = false;
  let handle = 0;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastMediaTime = -1;
  let clock: "capture" | "media" | "display" | null = null;

  /**
   * The best clock this browser offers for when a frame was taken, chosen
   * once: the camera's capture time, else the media clock if it advances,
   * else when the frame was shown (good to a display refresh).
   */
  const frameTime = (now: number, metadata: FrameMetadata) => {
    if (clock === null) {
      if (typeof metadata.captureTime === "number") clock = "capture";
      else if (lastMediaTime >= 0 && metadata.mediaTime > lastMediaTime) clock = "media";
      else if (lastMediaTime >= 0) clock = "display";
      lastMediaTime = metadata.mediaTime;
      if (clock === null) return null;
    }
    if (clock === "capture") return metadata.captureTime! / 1000;
    if (clock === "media") return metadata.mediaTime;
    return now / 1000;
  };

  const onMessage = ({ data }: MessageEvent<WorkerResponse>) => {
    if (data.kind === "snapshot") busy = false;
  };
  worker.addEventListener("message", onMessage);

  const grab = (timestamp: number) => {
    if (stopped) return;
    if (!busy && context && video.videoWidth > 0) {
      const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (width !== lastWidth || height !== lastHeight) {
        canvas.width = width;
        canvas.height = height;
        lastWidth = width;
        lastHeight = height;
        onSize(width, height);
      }
      context.drawImage(video, 0, 0, width, height);
      const rgba = context.getImageData(0, 0, width, height).data.buffer;
      busy = true;
      const message: WorkerRequest = { kind: "frame", rgba, width, height, timestamp, attitude: readAttitude() };
      worker.postMessage(message, [rgba]);
    }
    schedule();
  };

  const schedule = () => {
    if (stopped) return;
    if (v.requestVideoFrameCallback) {
      // The capture time of each frame, not when we happened to look.
      handle = v.requestVideoFrameCallback((now, metadata) => {
        const t = frameTime(now, metadata);
        if (t === null) schedule();
        else grab(t);
      });
    } else {
      handle = requestAnimationFrame((now) => grab(now / 1000));
    }
  };
  schedule();

  return () => {
    stopped = true;
    worker.removeEventListener("message", onMessage);
    if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(handle);
    else cancelAnimationFrame(handle);
  };
}
