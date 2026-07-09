import { FRAME_RATE_DEFAULT, snapFrameRate } from "./frameMath";

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

const METADATA_TIMEOUT_MS = 8000;

const readDimensions = (element: HTMLVideoElement): Omit<VideoMetadata, "fps"> => {
  const width = element.videoWidth || 0;
  const height = element.videoHeight || 0;
  const duration = Number.isFinite(element.duration) ? element.duration : 0;
  return { duration, width, height };
};

// Waits for a video element to report its metadata. Rejects on error and on a
// timeout so callers never hang on a source that fires neither event.
export const waitForMetadata = (element: HTMLVideoElement): Promise<Omit<VideoMetadata, "fps">> => {
  return new Promise((resolve, reject) => {
    if (element.readyState >= 1 && Number.isFinite(element.duration)) {
      resolve(readDimensions(element));
      return;
    }

    const cleanup = () => {
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onError);
      window.clearTimeout(timeoutId);
    };
    const onLoaded = () => {
      cleanup();
      resolve(readDimensions(element));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Unable to read video metadata"));
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out reading video metadata"));
    }, METADATA_TIMEOUT_MS);

    element.addEventListener("loadedmetadata", onLoaded, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
};

export const getMetadataFromUrl = async (
  videoUrl: string,
  { estimateFps = false }: { estimateFps?: boolean } = {}
): Promise<VideoMetadata> => {
  const element = document.createElement("video");
  element.preload = estimateFps ? "auto" : "metadata";
  element.muted = true;
  element.src = videoUrl;
  try {
    const dimensions = await waitForMetadata(element);
    // fps is measured on this detached element so the visible player is never
    // disturbed by the sampling playback burst.
    const fps = estimateFps ? await estimateFrameRate(element) : FRAME_RATE_DEFAULT;
    return { ...dimensions, fps };
  } finally {
    element.pause();
    element.removeAttribute("src");
    element.load();
    element.remove();
  }
};

export const getMetadataFromFile = async (file: File): Promise<VideoMetadata> => {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await getMetadataFromUrl(objectUrl, { estimateFps: true });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

// Estimates the real frame rate by sampling frame presentation times via
// requestVideoFrameCallback during a brief muted playback burst. HTML5 video
// exposes no fps in metadata, so without this every clip is assumed to be 30fps
// and frame stepping/indexing is wrong for 24/25/60fps sources.
export const estimateFrameRate = (
  video: HTMLVideoElement,
  { sampleCount = 12, timeoutMs = 1200 }: { sampleCount?: number; timeoutMs?: number } = {}
): Promise<number> => {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      resolve(FRAME_RATE_DEFAULT);
      return;
    }

    const mediaTimes: number[] = [];
    const previousMuted = video.muted;
    const previousPaused = video.paused;
    const previousTime = video.currentTime;
    let settled = false;
    let rafHandle = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      if (rafHandle && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(rafHandle);
      }
      // Restore the element to how we found it.
      try {
        if (previousPaused) video.pause();
        video.muted = previousMuted;
        if (Number.isFinite(previousTime)) video.currentTime = previousTime;
      } catch {
        // Ignore restoration errors on unsupported browsers.
      }

      if (mediaTimes.length < 3) {
        resolve(FRAME_RATE_DEFAULT);
        return;
      }
      const deltas: number[] = [];
      for (let i = 1; i < mediaTimes.length; i += 1) {
        const delta = mediaTimes[i] - mediaTimes[i - 1];
        if (delta > 0.0005) deltas.push(delta);
      }
      if (!deltas.length) {
        resolve(FRAME_RATE_DEFAULT);
        return;
      }
      deltas.sort((a, b) => a - b);
      const medianDelta = deltas[Math.floor(deltas.length / 2)];
      resolve(snapFrameRate(1 / medianDelta));
    };

    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (settled) return;
      mediaTimes.push(metadata.mediaTime);
      if (mediaTimes.length >= sampleCount) {
        finish();
        return;
      }
      rafHandle = video.requestVideoFrameCallback(onFrame);
    };

    const timeoutId = window.setTimeout(finish, timeoutMs);

    try {
      video.muted = true;
      rafHandle = video.requestVideoFrameCallback(onFrame);
      const playResult = video.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => finish());
      }
    } catch {
      finish();
    }
  });
};
