/**
 * The buttons for the clips that are evidence rather than the swing itself.
 *
 * Kept apart from whatever loads the swing, on purpose: neither is a swing
 * to watch, both are optional, and loading one must never be mistaken for
 * loading a swing. In the standalone lab they sit beside the clip picker; in
 * the booking app the swing is already chosen and these are the only file
 * buttons there are.
 *
 *   Standing shot   two seconds of the golfer standing still, from the SAME
 *                   camera -- measures that camera's pitch.
 *   Second angle    the SAME swing from another camera -- down the line
 *                   beside face-on, or the other way round -- fused with it
 *                   so each camera covers the other's blind depth.
 */

import { useRef } from "react";

import type { useVideoObservation } from "../useVideoObservation";

type VideoObservation = ReturnType<typeof useVideoObservation>;

export function ExtraClipButtons({ video }: { video: VideoObservation }) {
  const { status, calibrationFileName, secondAngleFileName, result } = video.state;
  const running = status === "running";

  return (
    <>
      <ClipButton
        label={calibrationFileName ? "Replace standing shot" : "Add standing shot"}
        title="Two seconds of the golfer standing still, from the same camera"
        disabled={running}
        onPick={(file) => void video.runStandingShot(file)}
      />
      {calibrationFileName && (
        <button type="button" className="lab-chip" onClick={video.clearStandingShot} disabled={running}>
          Drop it
        </button>
      )}
      <ClipButton
        label={secondAngleFileName ? "Replace second angle" : "Add second angle"}
        title="The same swing from another camera — down the line with face-on, or face-on with down the line"
        // Belongs to one swing, so there has to be a swing to belong to.
        disabled={running || !result}
        onPick={(file) => void video.runSecondAngle(file)}
      />
      {secondAngleFileName && (
        <button type="button" className="lab-chip" onClick={video.clearSecondAngle} disabled={running}>
          Drop second angle
        </button>
      )}
      {running && (
        <button type="button" className="lab-chip" onClick={video.cancel}>
          Cancel
        </button>
      )}
    </>
  );
}

function ClipButton({
  label,
  title,
  disabled,
  onPick,
}: {
  label: string;
  title: string;
  disabled: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="lab-chip"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title={title}
      >
        {label}
      </button>
    </>
  );
}
