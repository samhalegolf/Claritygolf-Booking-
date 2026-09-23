import type { FriendlyMarkerLabel, TimelineMarker } from "../models/Timeline";
import type { SwingPhaseKey, SwingPhases } from "../../../../motion-lab/src/embed/detectSwingPhases";

// The translation between the motion lab's swing phases and the workspace's
// timeline markers.
//
// The two sides grew separately and name things their own way: the lab
// speaks in phase keys and clip milliseconds, the timeline in friendly labels
// and seconds, with marker ids the analysis store and saved reviews already
// hold. This file is the only place that knows both, so neither side has to
// learn the other's vocabulary.

export const PHASE_FOR_LABEL: Record<FriendlyMarkerLabel, SwingPhaseKey> = {
  Setup: "setup",
  Takeaway: "takeaway",
  Top: "top",
  Delivery: "delivery",
  Impact: "impact",
  Finish: "finish",
};

/** Below this the lab's phase is not trusted over where the marker already is. */
export const MIN_PHASE_CONFIDENCE = 0.3;

export interface PlacedMarkers {
  markers: TimelineMarker[];
  /** Labels the lab placed. The rest kept their times. */
  placed: FriendlyMarkerLabel[];
}

/**
 * Move each marker to its phase.
 *
 * Ids, labels, colours and thumbnails ride through untouched -- only `time`
 * changes -- so a saved review that already references a marker still
 * finds it. A phase the lab did not find, or found with too little evidence,
 * leaves its marker where it was rather than dragging it somewhere worse.
 */
export const placeMarkersAtPhases = (
  current: readonly TimelineMarker[],
  result: SwingPhases,
  durationSeconds: number
): PlacedMarkers => {
  const placed: FriendlyMarkerLabel[] = [];
  const limit = Math.max(0, durationSeconds || 0);
  const markers = current.map((marker) => {
    const phase = result.phases[PHASE_FOR_LABEL[marker.label]];
    if (!phase || phase.confidence < MIN_PHASE_CONFIDENCE) return marker;
    placed.push(marker.label);
    // A thumbnail was cut at the old time and would now show the wrong frame.
    const { thumbnail: _stale, ...rest } = marker;
    return { ...rest, time: Math.min(limit, Math.max(0, phase.timeMs / 1000)) };
  });
  return { markers, placed };
};

/**
 * Whether the coach has touched these markers.
 *
 * Only untouched markers -- still at the evenly spaced defaults a fresh clip
 * gets -- are moved automatically. Anything a coach dragged, or that came
 * back with a saved review, is theirs, and detection never overrides it.
 */
export const markersAreUntouched = (
  current: readonly TimelineMarker[],
  defaults: readonly TimelineMarker[]
) =>
  current.length === defaults.length &&
  current.every((marker, index) => {
    const expected = defaults[index];
    return marker.label === expected.label && Math.abs(marker.time - expected.time) < 0.002;
  });
