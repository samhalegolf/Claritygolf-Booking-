import { keepPlaybackInline } from "./videoMetadata";

import { safeVideoThumbnail } from "./videoThumbnailPolicy";
export { safeVideoThumbnail } from "./videoThumbnailPolicy";

export const VIDEO_THUMBNAIL_PLACEHOLDER = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="144" viewBox="0 0 256 144"><rect width="256" height="144" fill="#173d36"/><path d="M112 50l36 22-36 22z" fill="#c7d9d3"/></svg>'
);

export function thumbnailSize(width: number, height: number) {
  const scale = Math.min(1, 256 / Math.max(width || 1, height || 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function thumbnailFromFrame(frame: CanvasImageSource, width: number, height: number): string | undefined {
  if (typeof document === "undefined" || !width || !height) return undefined;
  const canvas = document.createElement("canvas");
  Object.assign(canvas, thumbnailSize(width, height));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  try {
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.65, 0.45, 0.25]) {
      const image = safeVideoThumbnail(canvas.toDataURL("image/jpeg", quality));
      if (image) return image;
    }
  } catch { /* A tainted or unavailable frame is retried from the source. */ }
  return undefined;
}

export async function createVideoThumbnail(blob: Blob, supplied?: string): Promise<string | undefined> {
  if (typeof document === "undefined") return safeVideoThumbnail(supplied);
  if (supplied) {
    const image = new Image();
    const decoded = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { image.src = ""; resolve(false); }, 2000);
      image.onload = () => { clearTimeout(timer); resolve(true); };
      image.onerror = () => { clearTimeout(timer); resolve(false); };
      image.src = supplied;
    });
    if (decoded) {
      const thumbnail = thumbnailFromFrame(image, image.naturalWidth, image.naturalHeight);
      if (thumbnail) return thumbnail;
    }
  }
  if (!blob.size) return undefined;
  const video = document.createElement("video");
  keepPlaybackInline(video);
  video.muted = true;
  video.preload = "auto";
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (result?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.onloadeddata = video.onseeked = video.onerror = null;
        resolve(result);
      };
      const capture = () => finish(thumbnailFromFrame(video, video.videoWidth, video.videoHeight));
      const timer = setTimeout(() => finish(), 6000);
      video.onerror = () => finish();
      video.onseeked = capture;
      video.onloadeddata = () => {
        const time = Math.min(0.5, Number.isFinite(video.duration) ? video.duration / 10 : 0);
        if (time > 0.01) video.currentTime = time;
        else capture();
      };
      video.src = url;
      video.load();
    });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
