/**
 * The source video with the raw overlay on top.
 *
 * Paired with the 3D Space so the two can be compared directly: this one is
 * the evidence, that one is the reconstructed journey. Looking at them side
 * by side is how you find out whether the reconstruction is doing anything
 * useful or merely something pretty.
 */

import { useEffect, useRef } from "react";

import type { ObservationFrame } from "../../observe/observation";
import { RawOverlay } from "./RawOverlay";

export interface VideoPanelProps {
  readonly videoUrl: string;
  readonly frame: ObservationFrame | null;
  readonly width: number;
  readonly height: number;
  readonly showLowConfidence: boolean;
}

export function VideoPanel({
  videoUrl,
  frame,
  width,
  height,
  showLowConfidence,
}: VideoPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Drive the video from the playhead rather than letting it play. The
  // overlay has one set of landmarks, for one frame; a video running at its
  // own speed underneath would drift out of step with them within a second
  // and the overlay would look wrong when it was the pairing that was.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !frame) return;
    const target = frame.timestampMs / 1000;
    if (Math.abs(video.currentTime - target) > 0.004) {
      video.currentTime = target;
    }
  }, [frame]);

  return (
    <div className="lab-video-stage" style={{ aspectRatio: `${width} / ${height}` }}>
      <video ref={videoRef} src={videoUrl} muted playsInline preload="auto" />
      <RawOverlay
        frame={frame}
        width={width}
        height={height}
        showLowConfidence={showLowConfidence}
      />
    </div>
  );
}
