import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { PlaybackEngine } from "../engines/PlaybackEngine";
import { clamp, FRAME_RATE_DEFAULT } from "../utils/frameMath";
import { getMetadataFromFile } from "../utils/videoMetadata";

export interface UsePlaybackOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
}

export interface UsePlaybackState {
  sourceUrl: string | null;
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  frameRate: number;
  dimensions: { width: number; height: number };
  loadVideoFile: (file: File) => Promise<{
    sourceUrl: string;
    width: number;
    height: number;
    duration: number;
    fps: number;
  }>;
  clearSource: () => void;
  seekTo: (time: number) => void;
  play: () => void;
  pause: () => void;
  togglePlayPause: () => void;
  setSpeed: (speed: number) => void;
  speed: number;
  stepFrame: (direction: -1 | 1, options?: { shift?: boolean; heldFrames?: number }) => void;
}

const safeVideoDim = (value: number | undefined | null) => (Number.isFinite(value ?? NaN) ? value! : 0);

export function usePlayback({ videoRef }: UsePlaybackOptions): UsePlaybackState {
  const engine = useMemo(() => new PlaybackEngine(), []);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [frameRate, setFrameRate] = useState(FRAME_RATE_DEFAULT);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const lastObjectUrl = useRef<string | null>(null);
  const handleMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setDimensions((previous) => ({
      width: video.videoWidth || previous.width || 1,
      height: video.videoHeight || previous.height || 1,
    }));
  }, [videoRef]);

  const clearSource = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    const previousSource = lastObjectUrl.current;
    if (previousSource) {
      URL.revokeObjectURL(previousSource);
      lastObjectUrl.current = null;
    }
    setSourceUrl(null);
    setCurrentTime(0);
    setDuration(0);
    setDimensions({
      width: 0,
      height: 0,
    });
    setFrameRate(FRAME_RATE_DEFAULT);
    setIsPlaying(false);
  }, [videoRef]);

  useEffect(() => {
    return () => {
      if (lastObjectUrl.current) {
        URL.revokeObjectURL(lastObjectUrl.current);
        lastObjectUrl.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentTime(video.currentTime || 0);
    const onEnded = () => setIsPlaying(false);
    const onLoaded = () => handleMetadata();
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [videoRef, handleMetadata]);

  const loadVideoFile = useCallback(
    async (file: File) => {
      // Metadata + fps are measured on a detached element so we never fight the
      // React-controlled visible player nor flash a sampling burst to the user.
      const metadata = await getMetadataFromFile(file);
      const objectUrl = URL.createObjectURL(file);
      const previousObjectUrl = lastObjectUrl.current;
      setSourceUrl(objectUrl);
      if (previousObjectUrl && previousObjectUrl !== objectUrl) {
        // Keep the currently loaded source alive briefly while the new source is attached.
        window.requestAnimationFrame(() => {
          URL.revokeObjectURL(previousObjectUrl);
        });
      }
      lastObjectUrl.current = objectUrl;
      if (videoRef.current) {
        videoRef.current.src = objectUrl;
        videoRef.current.load();
      }
      setCurrentTime(0);
      setDuration(metadata.duration);
      setDimensions((previous) => ({
        width: metadata.width || previous.width,
        height: metadata.height || previous.height,
      }));
      setFrameRate(metadata.fps || FRAME_RATE_DEFAULT);
      const video = videoRef.current;
      const fallbackWidth = safeVideoDim(video?.videoWidth || 0);
      const fallbackHeight = safeVideoDim(video?.videoHeight || 0);
      return {
        sourceUrl: objectUrl,
        width: metadata.width || fallbackWidth,
        height: metadata.height || fallbackHeight,
        duration: metadata.duration,
        fps: metadata.fps || FRAME_RATE_DEFAULT,
      };
    },
    [videoRef]
  );

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (!video) return;
      const clamped = clamp(time, 0, Math.max(0, duration || video.duration || 0));
      video.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [duration, videoRef]
  );

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    void video.play();
  }, [videoRef]);

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
  }, [videoRef]);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, [videoRef]);

  const setSpeed = useCallback((nextSpeed: number) => {
    const video = videoRef.current;
    if (!video) return;
    const safe = clamp(nextSpeed, 0.25, 2.5);
    video.playbackRate = safe;
    setPlaybackSpeed(safe);
  }, [videoRef]);

  const stepFrame = useCallback(
    (direction: -1 | 1, options: { shift?: boolean; heldFrames?: number } = {}) => {
      const video = videoRef.current;
      if (!video) return;
      const target = engine.stepFrame({
        currentTime: video.currentTime || currentTime,
        direction,
        fps: frameRate,
        duration: duration || video.duration || 0,
        shift: !!options.shift,
        heldFrames: options.heldFrames,
      });
      seekTo(target);
    },
    [currentTime, duration, engine, frameRate, seekTo, videoRef]
  );

  return {
    sourceUrl,
    isPlaying,
    duration,
    currentTime,
    frameRate,
    dimensions,
    loadVideoFile,
    seekTo,
    play,
    pause,
    togglePlayPause,
    setSpeed,
    clearSource,
    speed: playbackSpeed,
    stepFrame,
  };
}
