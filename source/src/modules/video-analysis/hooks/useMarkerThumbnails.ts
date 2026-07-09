import { useEffect, useMemo, useRef } from "react";
import { TimelineMarker } from "../models/Timeline";

const THUMBNAIL_MAX_WIDTH = 160;
const THUMBNAIL_MAX_HEIGHT = 90;
const SEEK_TIMEOUT_MS = 1500;
const SEEK_TOLERANCE = 0.02;

interface UseMarkerThumbnailsOptions {
  sourceUrl: string | null;
  duration: number;
  markers: TimelineMarker[];
  enabled: boolean;
  onMarkersUpdated: (next: TimelineMarker[]) => void;
}

const clampTime = (value: number, duration: number) => {
  const safeDuration = Math.max(0.001, duration);
  return Math.max(0, Math.min(safeDuration, value));
};

const waitForReadyState = (video: HTMLVideoElement): Promise<void> =>
  new Promise((resolve) => {
    if (video.readyState >= 2) {
      resolve();
      return;
    }
    const cleanup = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onReady);
      clearTimeout(timeoutId);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const timeoutId = window.setTimeout(onReady, SEEK_TIMEOUT_MS);
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onReady, { once: true });
  });

const waitForSeek = (video: HTMLVideoElement, target: number): Promise<number> =>
  new Promise((resolve) => {
    if (Math.abs(video.currentTime - target) <= SEEK_TOLERANCE && video.readyState >= 2) {
      resolve(video.currentTime);
      return;
    }

    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      clearTimeout(timeoutId);
    };
    const onSeeked = () => {
      cleanup();
      resolve(video.currentTime);
    };
    const onError = () => {
      cleanup();
      resolve(video.currentTime);
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve(video.currentTime);
    }, SEEK_TIMEOUT_MS);

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = target;
  });

const captureFrame = async (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  time: number,
  targetWidth: number,
  targetHeight: number
) => {
  const clampedTime = clampTime(time, video.duration || 0);
  const capturedTime = await waitForSeek(video, clampedTime);
  const width = Math.max(1, targetWidth);
  const height = Math.max(1, targetHeight);
  const context = canvas.getContext("2d");
  if (!context) return null;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.drawImage(video, 0, 0, width, height);
  return {
    dataUrl: canvas.toDataURL("image/webp", 0.75),
    time: capturedTime,
  };
};

// Generates marker preview thumbnails on a detached video element that mirrors
// the source. This isolates the seeking/capture work so it never moves the
// visible player's playhead or fights the user's playback.
export function useMarkerThumbnails({
  sourceUrl,
  duration,
  markers,
  enabled,
  onMarkersUpdated,
}: UseMarkerThumbnailsOptions) {
  const pendingRunRef = useRef(0);
  const markersRef = useRef(markers);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    markersRef.current = markers;
  }, [markers]);

  // Own a detached video element bound to the current source.
  useEffect(() => {
    if (!sourceUrl) {
      if (videoRef.current) {
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
        videoRef.current = null;
      }
      return;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = sourceUrl;
    video.load();
    videoRef.current = video;
    return () => {
      video.removeAttribute("src");
      video.load();
      if (videoRef.current === video) videoRef.current = null;
    };
  }, [sourceUrl]);

  const markersNeedingThumbnail = useMemo(
    () => markers.filter((marker) => !marker.thumbnail),
    [markers]
  );

  useEffect(() => {
    if (!enabled || !sourceUrl || !duration) return;
    if (markersNeedingThumbnail.length === 0) return;
    const video = videoRef.current;
    if (!video) return;

    const runId = pendingRunRef.current + 1;
    pendingRunRef.current = runId;
    const canvas = canvasRef.current || (canvasRef.current = document.createElement("canvas"));
    const safeDuration = Math.max(0.001, duration);
    let isCanceled = false;

    const setThumbnailForMarker = (marker: TimelineMarker, dataUrl: string) => {
      const prev = markersRef.current;
      const next = prev.map((entry) =>
        entry.id === marker.id ? { ...entry, thumbnail: dataUrl } : entry
      );
      markersRef.current = next;
      onMarkersUpdated(next);
    };

    const run = async () => {
      await waitForReadyState(video);
      if (isCanceled || pendingRunRef.current !== runId) return;

      const renderWidth = Math.max(
        1,
        Math.floor(Math.min(THUMBNAIL_MAX_WIDTH, video.videoWidth || THUMBNAIL_MAX_WIDTH))
      );
      const ratio = Math.max(1, video.videoWidth || THUMBNAIL_MAX_WIDTH) / Math.max(1, renderWidth);
      const renderHeight = Math.max(
        1,
        Math.min(
          THUMBNAIL_MAX_HEIGHT,
          Math.round((video.videoHeight || THUMBNAIL_MAX_HEIGHT) / ratio)
        )
      );

      for (const marker of markersNeedingThumbnail) {
        if (isCanceled || pendingRunRef.current !== runId) return;
        if (marker.thumbnail) continue;
        try {
          const snapshot = await captureFrame(video, canvas, marker.time, renderWidth, renderHeight);
          if (!snapshot || isCanceled || pendingRunRef.current !== runId) return;
          const hasExpectedTime =
            Math.abs(snapshot.time - clampTime(marker.time, safeDuration)) <= 1;
          if (hasExpectedTime) {
            setThumbnailForMarker(marker, snapshot.dataUrl);
          }
        } catch {
          // Fallback to metadata-only preview at hover if capture fails.
        }
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    };

    void run();

    return () => {
      isCanceled = true;
      if (runId === pendingRunRef.current) {
        pendingRunRef.current = 0;
      }
    };
  }, [duration, enabled, markersNeedingThumbnail, onMarkersUpdated, sourceUrl]);
}
