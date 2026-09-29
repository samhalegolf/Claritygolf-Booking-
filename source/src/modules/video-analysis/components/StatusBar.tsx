import React from "react";
import { t } from "../../../lib/i18n";

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
          <span>{t("Current time")}</span>
          <b>{playback.time.toFixed(3)}s</b>
        </div>
        <div>
          <span>{t("Frame")}</span>
          <b>{frame}</b>
        </div>
        <div>
          <span>{t("fps")}</span>
          <b>{playback.fps.toFixed(1)}</b>
        </div>
        <div>
          <span>{t("Duration")}</span>
          <b>{playback.duration.toFixed(2)}s</b>
        </div>
        <div>
          <span>{t("Playback")}</span>
          <b>{playback.isPlaying ? "playing" : "paused"}</b>
        </div>
        <div>
          <span>{t("Draw")}</span>
          <b>{drawing.objectCount} • {drawing.selectedTool}</b>
        </div>
        <div>
          <span>{t("Marker hover")}</span>
          <b>{timeline.hover || "none"}</b>
        </div>
        <div>
          <span>{t("Timeline")}</span>
          <b>{t("zoom {zoom} •", { zoom: timeline.zoom.toFixed(1) })}{" "}{timeline.scrub ? "scrubbing" : "idle"}</b>
        </div>
      </div>
    </div>
  );
}

