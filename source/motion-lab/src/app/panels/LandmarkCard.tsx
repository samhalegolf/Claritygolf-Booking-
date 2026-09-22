/**
 * What a mark on the video is.
 *
 * The overlay draws MediaPipe's landmarks and nothing else, so the card says
 * so in MediaPipe's own terms -- its name, its index, what it reported -- and
 * then what Clarity does with it, which for a third of them is nothing.
 */

import { JOINT_SOURCES, MP } from "../../observe/mediapipe/landmarks";
import type { ObservationFrame, RawLandmark } from "../../observe/observation";
import { OBSERVATION_FLOORS } from "../../observe/toCameraFrame";

/**
 * What the detector itself believed about a point -- and, just as important,
 * what it did not.
 *
 * MediaPipe never says "derived": it emits a position for all 33 landmarks
 * every frame. It reports ONE belief about each, `visibility`, and this card
 * used to show a second one beside it called presence. That was Clarity's
 * own invention -- the tasks API surfaces only `visibility`, and the worker
 * was copying it into both fields, so two figures that read as corroborating
 * witnesses were one figure printed twice. The branch here for "in frame but
 * hidden" needed visibility under the half and presence over it, which a copy
 * can never be, so it never once fired.
 *
 * What is left is the honest reading, and it is narrower than the word
 * suggests: visibility answers "is this body part in the picture", not "is
 * this the right place for it". A landmark snapped onto the spine is still in
 * the picture, and reports the same 1.0 as a correct one. So the wording
 * below does not let "seen in the image" be read as "seen correctly".
 * Whether a point is in the right place is the body's question, and the
 * Motion Layer answers it from the bones.
 */
const detectorVerdict = (landmark: RawLandmark): string => {
  if (landmark.visibility >= 0.5) {
    return "this body part is in the picture — which is not a claim about where on it the point landed";
  }
  return "MediaPipe does not believe this point is in the picture — the position is a guess with nothing behind it";
};

const clarityVerdict = (landmark: RawLandmark, index: number): string => {
  if (JOINT_SOURCES.every((source) => !source.from.includes(index))) return "not used";
  const kept = landmark.visibility >= OBSERVATION_FLOORS.visibilityFloor;
  if (!kept) {
    return `discarded — under the ${(OBSERVATION_FLOORS.visibilityFloor * 100).toFixed(0)}% floor, treated as not observed`;
  }
  return landmark.visibility >= 0.5
    ? "used as an observation — then checked against the body, every frame"
    : `used, at ${(landmark.visibility * 100).toFixed(0)}% trust — bones and smoothing lean on it less`;
};

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
            <span>Image</span>
            <span>
              {(landmark.x * 100).toFixed(1)}%, {(landmark.y * 100).toFixed(1)}%
            </span>
          </div>
          <div className="lab-pick-row lab-pick-verdict">
            <span>MediaPipe says</span>
            <span>{detectorVerdict(landmark)}</span>
          </div>
          <div className="lab-pick-row lab-pick-verdict">
            <span>Clarity</span>
            <span>{clarityVerdict(landmark, index)}</span>
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
