import { useState } from "react";
import { MARKER_LABEL_TEXT, TimelineMarker } from "../models/Timeline";
import { t } from "../../../lib/i18n";
import { formatTime } from "../utils/frameMath";

interface MarkerPreviewProps {
  marker: TimelineMarker;
  left: number;
}

export function MarkerPreview({ marker, left }: MarkerPreviewProps) {
  const [thumbnailError, setThumbnailError] = useState(false);
  const hasThumbnail = Boolean(marker.thumbnail && !thumbnailError);

  return (
    <div className="timeline-thumb-preview" style={{ left: `${left}px` }}>
      <div className="timeline-thumb-label">{MARKER_LABEL_TEXT[marker.label] ?? marker.label}</div>
      {hasThumbnail ? (
        <img
          className="timeline-thumb-image"
          src={marker.thumbnail}
          alt={t("{marker} preview", { marker: MARKER_LABEL_TEXT[marker.label] ?? marker.label })}
          onError={() => setThumbnailError(true)}
          loading="eager"
        />
      ) : (
        <div className="timeline-thumb-fallback" />
      )}
      <div className="mini">t {formatTime(marker.time)}</div>
    </div>
  );
}
