/* Where a screenshot came from.
 *
 * A screenshot on its own is a crop with a caption. Most of what makes it
 * useful is the context that did not fit in the crop: what the rest of the
 * body was doing at that instant, and where in the swing the instant falls.
 * This puts the screenshot back where it was taken -- the video wound to its
 * frame and paused, with a box drawn over the part that was cropped -- and
 * keeps every other screenshot from the review in a rail beside it, so moving
 * between them is moving through the swing.
 *
 * Used by the coach's Player Profiles, the player's portal and the emailed
 * review page. None of them share a video source, so the video is resolved by
 * the caller: a blob from the device's library, or a streamed URL.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./snapshotFrameViewer.css";

export type FrameViewerRect = { x: number; y: number; width: number; height: number };

export type FrameViewerShot = {
  /** Unique across the whole review, not just one video. */
  key: string;
  savedVideoId: string;
  videoTitle: string;
  title: string;
  note?: string;
  /** Seconds into the video the screenshot was taken at. */
  currentTime: number;
  /** A whole frame has no box: the screenshot is the frame. */
  captureKind?: "frame" | "area";
  /** The cropped part, normalised 0–1 to the video. */
  cropRect?: FrameViewerRect | null;
  imageUrl?: string;
};

type Props = {
  shots: FrameViewerShot[];
  initialKey: string;
  /** A URL the <video> element can play. blob: URLs are revoked when the viewer
   *  moves off them, so return a fresh one each call. */
  resolveVideoUrl: (savedVideoId: string) => Promise<string | null>;
  onClose: () => void;
};

/** Close enough to the screenshot's instant that the box still describes the
 *  picture on screen -- about two frames at 30 fps. */
const ON_FRAME_TOLERANCE = 0.07;
const FRAME_STEP = 1 / 30;

const clock = (seconds: number) => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
};

export function boxForShot(shot: FrameViewerShot): FrameViewerRect | null {
  if (shot.captureKind === "frame") return null;
  const rect = shot.cropRect;
  if (!rect) return null;
  const covers = rect.x <= 0.001 && rect.y <= 0.001 && rect.width >= 0.999 && rect.height >= 0.999;
  return covers ? null : rect;
}

export function SnapshotFrameViewer({ shots, initialKey, resolveVideoUrl, onClose }: Props) {
  const ordered = useMemo(
    () =>
      [...shots].sort(
        (left, right) =>
          left.videoTitle.localeCompare(right.videoTitle) ||
          left.savedVideoId.localeCompare(right.savedVideoId) ||
          left.currentTime - right.currentTime,
      ),
    [shots],
  );
  const [activeKey, setActiveKey] = useState(
    () => (ordered.some((shot) => shot.key === initialKey) ? initialKey : ordered[0]?.key || ""),
  );
  const active = ordered.find((shot) => shot.key === activeKey) || ordered[0];
  const activeIndex = active ? ordered.indexOf(active) : -1;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const railRef = useRef<HTMLOListElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [videoUrl, setVideoUrl] = useState<{ savedVideoId: string; url: string } | null>(null);
  const [videoState, setVideoState] = useState<"loading" | "ready" | "missing">("loading");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);

  // Load the active shot's video when it changes to a different one.
  const activeVideoId = active?.savedVideoId || "";
  useEffect(() => {
    if (!activeVideoId) return;
    let cancelled = false;
    setVideoState("loading");
    resolveVideoUrl(activeVideoId)
      .then((url) => {
        if (cancelled) {
          if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        if (!url) {
          setVideoUrl(null);
          setVideoState("missing");
          return;
        }
        setVideoUrl({ savedVideoId: activeVideoId, url });
      })
      .catch(() => {
        if (!cancelled) setVideoState("missing");
      });
    return () => {
      cancelled = true;
    };
  }, [activeVideoId, resolveVideoUrl]);

  useEffect(() => {
    const url = videoUrl?.url;
    return () => {
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [videoUrl]);

  /** Where the video should be once it can get there. A seek issued at
   *  loadedmetadata is dropped by some files (phone recordings without a seek
   *  index among them), so it is re-applied when the video can play. */
  const pendingSeekRef = useRef<number | null>(null);

  const seekToActive = useCallback(() => {
    const video = videoRef.current;
    if (!video || !active || videoUrl?.savedVideoId !== active.savedVideoId) return;
    video.pause();
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration - 0.001 : Infinity;
    const target = Math.max(0, Math.min(active.currentTime, end));
    pendingSeekRef.current = target;
    video.currentTime = target;
    setTime(target);
  }, [active, videoUrl]);

  const settlePendingSeek = useCallback((video: HTMLVideoElement) => {
    const target = pendingSeekRef.current;
    if (target === null) return;
    if (Math.abs(video.currentTime - target) <= 0.02) {
      pendingSeekRef.current = null;
      return;
    }
    video.currentTime = target;
  }, []);

  // A new shot on the same video is only a seek; a new video seeks once its
  // metadata is in (onLoadedMetadata below).
  useEffect(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 1) seekToActive();
  }, [activeKey, seekToActive]);

  // Keep the active card in view as the coach steps through them.
  useEffect(() => {
    const rail = railRef.current;
    const card = rail?.querySelector<HTMLElement>(`[data-shot-key="${CSS.escape(activeKey)}"]`);
    card?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [activeKey]);

  const step = useCallback(
    (delta: number) => {
      if (!ordered.length) return;
      const next = ordered[(activeIndex + delta + ordered.length) % ordered.length];
      if (next) setActiveKey(next.key);
    },
    [activeIndex, ordered],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    pendingSeekRef.current = null;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  const nudge = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    pendingSeekRef.current = null;
    video.pause();
    const end = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), end);
  }, []);

  // Focus into the dialog on open and hand it back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown" || event.key === "PageDown" || (event.key === "ArrowRight" && event.shiftKey)) {
        event.preventDefault();
        step(1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp" || (event.key === "ArrowLeft" && event.shiftKey)) {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        nudge(FRAME_STEP);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        nudge(-FRAME_STEP);
      } else if (event.key === " " && target?.tagName !== "BUTTON") {
        event.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nudge, onClose, step, togglePlay]);

  // The page behind should not scroll under a full-screen viewer.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!active) return null;

  const box = boxForShot(active);
  const onFrame = !playing && Math.abs(time - active.currentTime) <= ON_FRAME_TOLERANCE;
  const sameVideo = ordered.filter((shot) => shot.savedVideoId === active.savedVideoId);
  const timelineLength = duration || Math.max(...sameVideo.map((shot) => shot.currentTime), 1);
  const videos = new Set(ordered.map((shot) => shot.savedVideoId)).size;

  // Portalled to <body>: a transformed ancestor anywhere in the three hosts
  // would otherwise turn position: fixed into "fixed to that ancestor".
  return createPortal(
    <div className="frame-viewer-backdrop" onClick={onClose}>
      <div
        className="frame-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="Screenshot in its video"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="frame-viewer-header">
          <div>
            <strong>{active.title}</strong>
            <span>
              {videos > 1 ? `${active.videoTitle} · ` : ""}
              {clock(active.currentTime)} · {activeIndex + 1} of {ordered.length}
            </span>
          </div>
          <button type="button" className="frame-viewer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="frame-viewer-body">
          <section className="frame-viewer-stage" aria-label="Video at the screenshot's frame">
            <div
              className="frame-viewer-picture"
              style={{ aspectRatio: String(aspect), ["--frame-aspect" as string]: String(aspect) }}
            >
              {videoUrl && videoUrl.savedVideoId === active.savedVideoId ? (
                <video
                  key={videoUrl.url}
                  ref={videoRef}
                  src={videoUrl.url}
                  playsInline
                  muted
                  preload="auto"
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    if (video.videoWidth && video.videoHeight) setAspect(video.videoWidth / video.videoHeight);
                    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
                    setVideoState("ready");
                    seekToActive();
                  }}
                  onCanPlay={(event) => settlePendingSeek(event.currentTarget)}
                  onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
                  onSeeked={(event) => {
                    setTime(event.currentTarget.currentTime);
                    settlePendingSeek(event.currentTarget);
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() => setVideoState("missing")}
                />
              ) : null}
              {videoState === "missing" ? (
                <div className="frame-viewer-missing">
                  {active.imageUrl ? <img src={active.imageUrl} alt="" /> : null}
                  <p>The video for this screenshot is not on this device.</p>
                </div>
              ) : videoState === "loading" ? (
                <div className="frame-viewer-missing">
                  <p>Loading the video…</p>
                </div>
              ) : null}
              {videoState === "ready" && box ? (
                <div
                  className={`frame-viewer-box${onFrame ? "" : " is-away"}`}
                  style={{
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.width * 100}%`,
                    height: `${box.height * 100}%`,
                  }}
                  aria-hidden="true"
                />
              ) : null}
              {videoState === "ready" && !box && onFrame ? (
                <div className="frame-viewer-whole" aria-hidden="true">
                  <span>Whole frame</span>
                </div>
              ) : null}
            </div>

            <div className="frame-viewer-controls">
              <button type="button" onClick={() => nudge(-FRAME_STEP)} aria-label="Back one frame">
                ‹
              </button>
              <button type="button" className="is-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <button type="button" onClick={() => nudge(FRAME_STEP)} aria-label="Forward one frame">
                ›
              </button>
              <div
                className="frame-viewer-timeline"
                onClick={(event) => {
                  const video = videoRef.current;
                  if (!video || !timelineLength) return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  pendingSeekRef.current = null;
                  video.pause();
                  video.currentTime = ((event.clientX - bounds.left) / bounds.width) * timelineLength;
                }}
              >
                <div className="frame-viewer-track" />
                <div
                  className="frame-viewer-playhead"
                  style={{ left: `${Math.min(100, (time / timelineLength) * 100)}%` }}
                />
                {sameVideo.map((shot) => (
                  <button
                    type="button"
                    key={shot.key}
                    className={`frame-viewer-marker${shot.key === active.key ? " is-active" : ""}`}
                    style={{ left: `${Math.min(100, (shot.currentTime / timelineLength) * 100)}%` }}
                    title={`${shot.title} · ${clock(shot.currentTime)}`}
                    aria-label={`${shot.title} at ${clock(shot.currentTime)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setActiveKey(shot.key);
                      if (shot.key === active.key) seekToActive();
                    }}
                  />
                ))}
              </div>
              <span className="frame-viewer-time">{clock(time)}</span>
              {!onFrame ? (
                <button type="button" className="frame-viewer-return" onClick={seekToActive}>
                  Back to screenshot
                </button>
              ) : null}
            </div>

            {active.note ? <p className="frame-viewer-note">{active.note}</p> : null}
          </section>

          <ol className="frame-viewer-rail" ref={railRef} aria-label="Screenshots in this review">
            {ordered.map((shot, index) => {
              const previous = ordered[index - 1];
              const newVideo = videos > 1 && (!previous || previous.savedVideoId !== shot.savedVideoId);
              return (
                <li key={shot.key} data-shot-key={shot.key}>
                  {newVideo ? <span className="frame-viewer-rail-video">{shot.videoTitle}</span> : null}
                  <button
                    type="button"
                    className={`frame-viewer-card${shot.key === active.key ? " is-active" : ""}`}
                    aria-current={shot.key === active.key ? "true" : undefined}
                    onClick={() => {
                      setActiveKey(shot.key);
                      if (shot.key === active.key) seekToActive();
                    }}
                  >
                    <span className="frame-viewer-thumb">
                      {shot.imageUrl ? <img src={shot.imageUrl} alt="" /> : <span>{clock(shot.currentTime)}</span>}
                    </span>
                    <span className="frame-viewer-card-text">
                      <strong>{shot.title}</strong>
                      <small>{clock(shot.currentTime)}</small>
                      {shot.note ? <em>{shot.note}</em> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
        <footer className="frame-viewer-hint">
          ↑ ↓ screenshot · ← → one frame · space play
        </footer>
      </div>
    </div>,
    document.body,
  );
}
