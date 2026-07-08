import React from "react";

interface StatusBarProps {
  playback: {
    time: number;
    frame: number;
    fps: number;
    duration: number;
    isPlaying: boolean;
  };
  timeline: {
    scrub: boolean;
    hover: string | null;
    zoom: number;
  };
  drawing: {
    selectedTool: string;
    selectedObjectId: string | null;
    objectCount: number;
    undoSize: number;
    redoSize: number;
  };
}

export function StatusBar({
  playback,
  timeline,
  drawing,
}: StatusBarProps) {
  const frame = Math.max(0, Math.round(playback.time * playback.fps));
  return (
    <div className="status-panel">
      <div className="status-grid">
        <div>
          <span>Current time</span>
          <b>{playback.time.toFixed(3)}s</b>
        </div>
        <div>
          <span>Frame</span>
          <b>{frame}</b>
        </div>
        <div>
          <span>fps</span>
          <b>{playback.fps.toFixed(1)}</b>
        </div>
        <div>
          <span>Duration</span>
          <b>{playback.duration.toFixed(2)}s</b>
        </div>
        <div>
          <span>Playback</span>
          <b>{playback.isPlaying ? "playing" : "paused"}</b>
        </div>
        <div>
          <span>Draw</span>
          <b>{drawing.objectCount} • {drawing.selectedTool}</b>
        </div>
        <div>
          <span>Marker hover</span>
          <b>{timeline.hover || "none"}</b>
        </div>
        <div>
          <span>Timeline</span>
          <b>zoom {timeline.zoom.toFixed(1)} • {timeline.scrub ? "scrubbing" : "idle"}</b>
        </div>
      </div>
    </div>
  );
}

