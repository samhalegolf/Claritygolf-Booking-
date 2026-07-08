import { useState } from "react";
import { TimelineMarker } from "../models/Timeline";

export interface UseTimelineState {
  zoom: number;
  setZoom: (value: number) => void;
  hoverMarker: TimelineMarker | null;
  setHoverMarker: (marker: TimelineMarker | null) => void;
  isScrubbing: boolean;
  setScrubbing: (value: boolean) => void;
}

// Owns transient timeline view state only. Marker data is owned by the analysis
// store (single source of truth); this hook no longer keeps a parallel copy.
export function useTimeline(): UseTimelineState {
  const [zoom, setZoom] = useState(1);
  const [hoverMarker, setHoverMarker] = useState<TimelineMarker | null>(null);
  const [isScrubbing, setScrubbing] = useState(false);

  return {
    zoom,
    setZoom,
    hoverMarker,
    setHoverMarker,
    isScrubbing,
    setScrubbing,
  };
}
