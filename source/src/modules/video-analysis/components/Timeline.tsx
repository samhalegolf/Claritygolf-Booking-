import React, { useCallback, useRef, useState } from "react";
import { MarkerPreview } from "./MarkerPreview";
import { TimelineEngine } from "../engines/TimelineEngine";
import { TimelineMarker } from "../models/Timeline";

export interface TimelineProps {
  duration: number;
  currentTime: number;
  zoom: number;
  markers: TimelineMarker[];
  hoverMarker: TimelineMarker | null;
  compact?: boolean;
  sideLabel?: string;
  onSeek: (time: number) => void;
  onSetHoverMarker: (marker: TimelineMarker | null) => void;
  onJumpToMarker: (marker: TimelineMarker) => void;
  onMoveMarker?: (marker: TimelineMarker, time: number) => void;
  onScrubStateChange: (scrubbing: boolean) => void;
  onZoomChange: (zoom: number) => void;
  className?: string;
}

export function Timeline({
  duration,
  currentTime,
  zoom,
  markers,
  hoverMarker,
  compact = false,
  sideLabel,
  onSeek,
  onSetHoverMarker,
  onJumpToMarker,
  onMoveMarker,
  onScrubStateChange,
  onZoomChange,
  className,
}: TimelineProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [previewX, setPreviewX] = useState<number | null>(null);
  const markerDownRef = useRef<{ id: string; x: number; t: number } | null>(null);
  const isDownRef = useRef(false);
  const timelineEngine = useRef(new TimelineEngine()).current;
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingMarkerRef = useRef(false);
  const MARKER_CLICK_DISTANCE = 9;
  const MARKER_CLICK_TIME_MS = 300;

  const safeDuration = Math.max(0.001, duration);
  const resolveTrackWidth = () => {
    const measured = containerRef.current?.getBoundingClientRect().width || 0;
    return Math.max(1, measured || trackWidth || 1);
  };

  const commitMove = useCallback((eventX: number, width: number) => {
    if (duration <= 0) return;
    const time = timelineEngine.xToTime(eventX, width, duration);
    onSeek(time);
  },
    [duration, onSeek, timelineEngine]
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(".timeline-marker")) {
      return;
    }
    const width = resolveTrackWidth();
    setTrackWidth(width);
    if (duration <= 0) return;

    isDownRef.current = true;
    onScrubStateChange(true);

    const rect = event.currentTarget.getBoundingClientRect();
    commitMove(event.clientX - rect.left, width);
    onSetHoverMarker(null);

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDownRef.current) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    commitMove(event.clientX - rect.left, resolveTrackWidth());
    onSetHoverMarker(null);
    event.preventDefault();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDownRef.current) return;
    isDownRef.current = false;
    markerDownRef.current = null;
    isDraggingMarkerRef.current = false;
    onScrubStateChange(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerCancel = () => {
    isDownRef.current = false;
    isDraggingMarkerRef.current = false;
    markerDownRef.current = null;
    onScrubStateChange(false);
  };

  const onMarkerEnter = (marker: TimelineMarker, x: number) => {
    onSetHoverMarker(marker);
    setPreviewX(Math.max(0, Math.min(resolveTrackWidth(), x)));
  };

  const onMarkerLeave = () => {
    onSetHoverMarker(null);
    setPreviewX(null);
  };

  const onMarkerDown = (marker: TimelineMarker, x: number) => {
    markerDownRef.current = { id: marker.id, x, t: performance.now() };
    isDraggingMarkerRef.current = false;
  };

  const onMarkerUp = (marker: TimelineMarker, x: number) => {
    const state = markerDownRef.current;
    if (!state || state.id !== marker.id) return;
    const dist = Math.abs(x - state.x);
    const elapsed = performance.now() - state.t;
    const wasDrag = isDraggingMarkerRef.current || dist >= MARKER_CLICK_DISTANCE;
    if (!wasDrag && elapsed < MARKER_CLICK_TIME_MS) {
      onJumpToMarker(marker);
    }
    isDraggingMarkerRef.current = false;
    markerDownRef.current = null;
  };

  const onMarkerDrag = (marker: TimelineMarker, clientX: number) => {
    if (!markerDownRef.current || markerDownRef.current.id !== marker.id) return;
    if (Math.abs(clientX - markerDownRef.current.x) > MARKER_CLICK_DISTANCE) {
      isDraggingMarkerRef.current = true;
    }
    // Once past the click threshold, reposition the marker to follow the cursor.
    if (isDraggingMarkerRef.current && onMoveMarker && duration > 0) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const time = timelineEngine.xToTime(
          clientX - rect.left,
          rect.width || resolveTrackWidth(),
          duration
        );
        onMoveMarker(marker, time);
      }
    }
  };

  const onTrackMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!markers.length || duration <= 0) return;
    const width = resolveTrackWidth();
    const rect = event.currentTarget.getBoundingClientRect();
    const { marker, distancePx } = timelineEngine.hitMarker(
      event.clientX - rect.left,
      width,
      duration,
      markers
    );
    if (distancePx <= 9) {
      setPreviewX(Math.min(rect.width, event.clientX - rect.left));
      onSetHoverMarker(marker);
    } else if (!isDownRef.current) {
      onSetHoverMarker(null);
      setPreviewX(null);
    }
  };

  const playheadPosPercent = duration > 0 ? (Math.min(currentTime, safeDuration) / safeDuration) * 100 : 0;
  const safeTrackWidth = Math.max(1, trackWidth);

  const titleText = compact ? `${sideLabel ? `${sideLabel} ` : ""}timeline` : "Timeline";
  const wrapClassName = ["timeline-wrap", compact ? "is-compact" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapClassName}>
      <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: compact ? 11 : 12, color: "#c3cee6" }}>{titleText}</span>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: "#94a2c0" }}>Zoom</span>
          <input
            type="range"
            min={0.6}
            max={1.8}
            step={0.1}
            value={zoom}
            onChange={(event) => onZoomChange(parseFloat(event.target.value))}
          />
        </div>
      </div>
      <div
        className="timeline-track"
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onMouseMove={onTrackMouseMove}
        onMouseLeave={() => {
          setPreviewX(null);
          onSetHoverMarker(null);
          markerDownRef.current = null;
          if (isDownRef.current) {
            isDownRef.current = false;
            onScrubStateChange(false);
          }
        }}
      >
        <div
          className="timeline-progress"
          style={{ width: `${Math.max(0, Math.min(100, playheadPosPercent))}%` }}
        />
        <div className="timeline-playhead" style={{ left: `${playheadPosPercent}%` }} />
        {markers.map((marker) => {
          const left = (marker.time / safeDuration) * 100;
          const markerLeftPx = (marker.time / safeDuration) * safeTrackWidth;
          return (
            <div
              key={marker.id}
              style={{ left: `${left}%` }}
              className="timeline-marker"
              title={marker.label}
              onMouseEnter={() => onMarkerEnter(marker, markerLeftPx)}
              onMouseLeave={onMarkerLeave}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkerDown(marker, event.clientX);
                isDraggingMarkerRef.current = false;
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkerDown(marker, event.clientX);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onMouseUp={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkerUp(marker, event.clientX);
              }}
              onPointerUp={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkerUp(marker, event.clientX);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerMove={(event) => {
                onMarkerDrag(marker, event.clientX);
              }}
              onPointerLeave={() => {
                if (isDraggingMarkerRef.current) {
                  markerDownRef.current = null;
                }
              }}
            />
          );
        })}
        <div className="timeline-markers">
          {markers.map((marker) => (
            <div
              key={`${marker.id}-label`}
              className="timeline-marker-label"
              style={{ left: `${(marker.time / safeDuration) * 100}%` }}
            >
              {marker.label}
            </div>
          ))}
        </div>
        <div className="timeline-scale" />
      </div>
      {hoverMarker && previewX !== null ? (
        <MarkerPreview marker={hoverMarker} left={previewX} />
      ) : null}
    </div>
  );
}
