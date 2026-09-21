/**
 * Pulling frames out of a video, in order, without missing any.
 *
 * WHY SEEKING RATHER THAN PLAYING
 *
 * The obvious approach is to play the video and grab frames from
 * `requestVideoFrameCallback`. It is smooth, it is easy, and it is wrong for
 * this: pose inference takes tens of milliseconds per frame, so playback
 * outruns the detector and frames are silently skipped. The gaps that
 * produces are indistinguishable, downstream, from the detector having lost
 * the golfer -- so the Motion Layer would spend its effort reconstructing
 * around damage this file caused.
 *
 * Seeking is slower and completely deterministic. Every frame is visited, in
 * order, exactly once. For offline analysis that trade is not close.
 *
 * WHAT SEEKING DOES NOT GUARANTEE
 *
 * `currentTime = t` lands on the frame containing t, which needs t to be
 * inside the intended frame rather than on its boundary -- so each seek
 * targets the MIDDLE of its frame. Even then, a variable-frame-rate source
 * (most phone video) has frames that do not sit on the nominal grid, so a
 * seek can land on the same decoded frame twice. That is reported rather than
 * hidden: each extracted frame carries the video's own `currentTime`, and a
 * repeat is visible as two frames with the same one.
 */

import { keepPlaybackInline, waitForMetadata } from "../lifted/videoMetadata";
import { estimateFrameRate } from "../lifted/videoMetadata";
import { resolveFrameRate } from "../lifted/frameMath";

export interface VideoSourceInfo {
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly fps: number;
  readonly frameCount: number;
}

export interface ExtractedFrame {
  readonly index: number;
  /** Where we asked to be, in milliseconds. */
  readonly timestampMs: number;
  /** Where the video actually landed. A repeat means a duplicate decode. */
  readonly actualTimeMs: number;
  readonly bitmap: ImageBitmap;
}

const SEEK_TIMEOUT_MS = 5000;

/** Load a file into a detached video element and measure it. */
export const openVideo = async (
  file: File | Blob
): Promise<{ video: HTMLVideoElement; info: VideoSourceInfo; release: () => void }> => {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  keepPlaybackInline(video);
  video.muted = true;
  video.preload = "auto";
  video.src = objectUrl;

  const release = () => {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(objectUrl);
  };

  try {
    const dimensions = await waitForMetadata(video);
    // Measured, not assumed. Without this every clip is treated as 30fps and
    // frame indices are wrong for the 60, 120 and 240fps sources that a swing
    // is most likely to be shot on.
    const fps = resolveFrameRate(await estimateFrameRate(video));
    const durationMs = dimensions.duration * 1000;

    return {
      video,
      release,
      info: {
        width: dimensions.width,
        height: dimensions.height,
        durationMs,
        fps,
        frameCount: Math.max(1, Math.floor((durationMs / 1000) * fps)),
      },
    };
  } catch (error) {
    release();
    throw error;
  }
};

const seekTo = (video: HTMLVideoElement, timeSeconds: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      window.clearTimeout(timer);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to seek to ${timeSeconds.toFixed(3)}s`));
    };
    // A seek that fires neither event would hang the whole extraction with no
    // way to tell what went wrong.
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out seeking to ${timeSeconds.toFixed(3)}s`));
    }, SEEK_TIMEOUT_MS);

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = timeSeconds;
  });

export interface ExtractOptions {
  readonly signal?: AbortSignal;
  /** Only every nth frame. Useful for a fast first pass over a long clip. */
  readonly stride?: number;
}

/**
 * Walk the video frame by frame.
 *
 * A generator so the caller can run inference between frames without this
 * file knowing anything about detectors, and so aborting is just breaking out
 * of the loop. The caller owns each bitmap and must close it -- ImageBitmaps
 * hold GPU memory that garbage collection will not reclaim promptly, and a
 * few hundred un-closed 1080p frames will exhaust it.
 */
export async function* extractFrames(
  video: HTMLVideoElement,
  info: VideoSourceInfo,
  options: ExtractOptions = {}
): AsyncGenerator<ExtractedFrame> {
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  const frameDuration = 1 / info.fps;

  for (let index = 0; index < info.frameCount; index += stride) {
    if (options.signal?.aborted) return;

    // Aim at the middle of the frame. Seeking to its leading edge is a
    // coin-flip between this frame and the one before it.
    const target = Math.min(
      info.durationMs / 1000 - 1e-4,
      index * frameDuration + frameDuration / 2
    );
    await seekTo(video, target);
    if (options.signal?.aborted) return;

    yield {
      index,
      timestampMs: target * 1000,
      actualTimeMs: video.currentTime * 1000,
      bitmap: await createImageBitmap(video),
    };
  }
}
