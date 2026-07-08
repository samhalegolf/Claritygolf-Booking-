export const FRAME_RATE_DEFAULT = 30;
export const MIN_FRAME_RATE = 1;
export const MAX_FRAME_RATE = 120;

export const clamp = (value: number, min = 0, max = 1) =>
  Math.min(Math.max(value, min), max);

export const formatTime = (timeInSeconds: number) => {
  if (!Number.isFinite(timeInSeconds)) return "00:00.000";
  const totalMs = Math.max(0, Math.round(timeInSeconds * 1000));
  const mins = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const mm = mins.toString().padStart(2, "0");
  const ss = secs.toString().padStart(2, "0");
  return `${mm}:${ss}.${ms.toString().padStart(3, "0")}`;
};

export const clampFrameRate = (value: number) =>
  clamp(value, MIN_FRAME_RATE, MAX_FRAME_RATE);

export const resolveFrameRate = (fps?: number) =>
  Number.isFinite(fps ?? 0)
    ? clampFrameRate(fps as number)
    : FRAME_RATE_DEFAULT;

// Common capture/broadcast frame rates. A measured rate is snapped to the
// nearest of these when it lands close, so small sampling jitter does not
// leave us with values like 29.94 or 59.8.
const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

export const snapFrameRate = (rawFps: number): number => {
  if (!Number.isFinite(rawFps) || rawFps <= 0) return FRAME_RATE_DEFAULT;
  let closest = COMMON_FRAME_RATES[0];
  let closestDelta = Math.abs(rawFps - closest);
  for (const candidate of COMMON_FRAME_RATES) {
    const delta = Math.abs(rawFps - candidate);
    if (delta < closestDelta) {
      closest = candidate;
      closestDelta = delta;
    }
  }
  // Only snap when we are within ~5% of a known rate; otherwise trust the
  // measurement (clamped) so unusual sources are not forced to 30.
  if (closestDelta <= closest * 0.05) return closest;
  return clampFrameRate(rawFps);
};

export const secondsToFrame = (time: number, fps: number) =>
  Math.round(time * resolveFrameRate(fps));

export const frameToSeconds = (frame: number, fps: number) =>
  frame / resolveFrameRate(fps);

export const createId = (prefix = "id") =>
  `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

