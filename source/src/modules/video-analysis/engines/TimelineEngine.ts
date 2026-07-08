import { clamp } from "../utils/frameMath";
import { TimelineMarker, FriendlyMarkerLabel } from "../models/Timeline";

export interface HitResult {
  marker: TimelineMarker | null;
  distancePx: number;
}

export class TimelineEngine {
  private readonly defaultMarkerLabels: FriendlyMarkerLabel[] = [
    "Setup",
    "Takeaway",
    "Top",
    "Delivery",
    "Impact",
    "Finish",
  ];

  getDefaultMarkers(duration: number): TimelineMarker[] {
    const safeDuration = Math.max(0.001, duration || 0);
    const anchors = [0.08, 0.2, 0.35, 0.53, 0.72, 0.9];
    return anchors.map((ratio, index) => ({
      id: `marker-${index + 1}`,
      label: this.defaultMarkerLabels[index % this.defaultMarkerLabels.length],
      time: clamp(safeDuration * ratio, 0, safeDuration),
    }));
  }

  xToTime(clientX: number, width: number, duration: number) {
    const safeWidth = Math.max(1, width);
    const ratio = clamp(clientX / safeWidth, 0, 1);
    return clamp(ratio * duration, 0, Math.max(0, duration));
  }

  timeToX(time: number, width: number, duration: number) {
    const safeWidth = Math.max(1, width);
    const denom = Math.max(0.001, clamp(duration, 0.001, Number.MAX_VALUE));
    return (clamp(time, 0, denom) / denom) * safeWidth;
  }

  hitMarker(clientX: number, width: number, duration: number, markers: TimelineMarker[]): HitResult {
    if (!markers.length) return { marker: null, distancePx: Number.POSITIVE_INFINITY };
    const safeWidth = Math.max(1, width);
    let best: HitResult = { marker: null, distancePx: Number.POSITIVE_INFINITY };
    for (const marker of markers) {
      const x = (marker.time / Math.max(0.001, duration)) * safeWidth;
      const distance = Math.abs(x - clientX);
      if (distance < best.distancePx) {
        best = { marker, distancePx: distance };
      }
    }
    return best;
  }
}
