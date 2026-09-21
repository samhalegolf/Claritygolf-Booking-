/**
 * The second clip's buttons.
 *
 * Kept apart from whatever loads the swing, on purpose: a standing shot is a
 * different kind of evidence, it is optional, and loading one must never be
 * mistaken for loading a swing. In the standalone lab it sits beside the
 * clip picker; in the booking app the swing is already chosen and these are
 * the only file buttons there are.
 */

import { useRef } from "react";

import type { ObservationStatus } from "../useVideoObservation";

export function StandingShotButtons({
  status,
  calibrationFileName,
  onPick,
  onClear,
  onCancel,
}: {
  status: ObservationStatus;
  calibrationFileName: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const running = status === "running";

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
        disabled={running}
        title="Two seconds of the golfer standing still, from the same camera"
      >
        {calibrationFileName ? "Replace standing shot" : "Add standing shot"}
      </button>
      {calibrationFileName && (
        <button type="button" className="lab-chip" onClick={onClear} disabled={running}>
          Drop it
        </button>
      )}
      {running && (
        <button type="button" className="lab-chip" onClick={onCancel}>
          Cancel
        </button>
      )}
    </>
  );
}
