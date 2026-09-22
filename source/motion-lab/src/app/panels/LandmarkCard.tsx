/**
 * What a mark on the video is.
 *
 * The overlay draws MediaPipe's landmarks and nothing else, so the card says
 * so in MediaPipe's own terms -- its name, its index, what it reported -- and
 * then what Clarity does with it, which for a third of them is nothing.
 */

import { JOINT_SOURCES, MP } from "../../observe/mediapipe/landmarks";
import type { ObservationFrame } from "../../observe/observation";

/** Index -> MediaPipe's name for it. */
const LANDMARK_NAMES: readonly string[] = Object.entries(MP)
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name.toLowerCase().replace(/_/g, " "));

const clarityUse = (index: number): string => {
  const sources = JOINT_SOURCES.filter((source) => source.from.includes(index));
  if (sources.length === 0) return "not used by Clarity";
  return sources
    .map((source) =>
      source.from.length === 1
        ? `Clarity ${source.joint}`
        : `half of Clarity ${source.joint}`
    )
    .join(", ");
};

export function LandmarkCard({
  frame,
  index,
  onClose,
}: {
  frame: ObservationFrame | null;
  index: number;
  onClose: () => void;
}) {
  const landmark = frame?.image?.[index] ?? null;
  const name = LANDMARK_NAMES[index] ?? `landmark ${index}`;

  return (
    <div className="lab-pick-card">
      <div className="lab-pick-card-head">
        <strong>{name}</strong>
        <button type="button" className="lab-pick-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="lab-pick-row">
        <span>MediaPipe landmark</span>
        <span>#{index}</span>
      </div>
      <div className="lab-pick-row">
        <span>Feeds</span>
        <span>{clarityUse(index)}</span>
      </div>
      {landmark ? (
        <>
          <div className="lab-pick-row">
            <span>Visibility</span>
            <span>
              {(landmark.visibility * 100).toFixed(0)}%
              {landmark.visibility < 0.5 ? " — drawn amber" : ""}
            </span>
          </div>
          <div className="lab-pick-row">
            <span>Presence</span>
            <span>{(landmark.presence * 100).toFixed(0)}%</span>
          </div>
          <div className="lab-pick-row">
            <span>Image</span>
            <span>
              {(landmark.x * 100).toFixed(1)}%, {(landmark.y * 100).toFixed(1)}%
            </span>
          </div>
        </>
      ) : (
        <p className="lab-panel-note">Not detected on this frame.</p>
      )}
      <p className="lab-panel-note">
        Raw detector output. Nothing from the Motion Layer is drawn on the video.
      </p>
    </div>
  );
}
