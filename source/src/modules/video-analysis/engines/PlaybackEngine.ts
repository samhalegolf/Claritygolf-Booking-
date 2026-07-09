import {
  clamp,
  resolveFrameRate,
  frameToSeconds,
} from "../utils/frameMath";

export interface FrameStepOptions {
  currentTime: number;
  direction: -1 | 1;
  fps: number;
  duration: number;
  shift: boolean;
  heldFrames?: number;
}

export class PlaybackEngine {
  stepFrame({
    currentTime,
    direction,
    fps,
    duration,
    shift,
    heldFrames = 1,
  }: FrameStepOptions): number {
    const safeFps = resolveFrameRate(fps);
    const frame = Math.round(currentTime * safeFps);
    const base = shift ? 4 : 1;
    const extra = heldFrames > 2 ? Math.min(8, 1 + Math.floor(heldFrames / 2)) : 1;
    const nextFrame = frame + direction * base * extra;
    return clamp(frameToSeconds(nextFrame, safeFps), 0, Math.max(0, duration));
  }

  clampTime(currentTime: number, duration: number) {
    return clamp(currentTime, 0, Math.max(0, duration));
  }

  isPlaying(video: HTMLVideoElement | null) {
    return !!video && !video.paused && !video.ended;
  }
}

