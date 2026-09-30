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
 *                   so each camera covers the other's blind depth. Picked
 *                   from the host's library when it offers one, or uploaded.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

import type { useVideoObservation } from "../useVideoObservation";

type VideoObservation = ReturnType<typeof useVideoObservation>;

/** A clip the host's library could supply as the second angle. */
export interface SecondAngleClip {
  readonly id: string;
  readonly title: string;
  /** A line under the title: when it was filmed, where it is kept. */
  readonly detail: string;
  readonly thumbnail?: string;
  /** The library already takes this for the same swing from another camera. */
  readonly sameSwing?: boolean;
}

/**
 * The host's library, as the lab sees it. The lab never learns how the host
 * stores anything: it asks for a list and for one clip's bytes.
 */
export interface SecondAngleLibrary {
  list(): Promise<readonly SecondAngleClip[]>;
  load(id: string): Promise<{ readonly blob: Blob; readonly name: string }>;
}

export function ExtraClipButtons({
  video,
  library,
  onSecondAngle = (file) => void video.runSecondAngle(file),
}: {
  video: VideoObservation;
  library?: SecondAngleLibrary;
  /** A second angle was chosen. `id` is its library id; absent for an upload. */
  onSecondAngle?: (file: File, id?: string) => void;
}) {
  const { status, calibrationFileName, secondAngleFileName, result } = video.state;
  const running = status === "running";
  const [pickerOpen, setPickerOpen] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  // Belongs to one swing, so there has to be a swing to belong to.
  const secondDisabled = running || !result;

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
      <HiddenFileInput inputRef={uploadRef} onPick={(file) => onSecondAngle(file)} />
      <span className="lab-picker-anchor">
        <button
          type="button"
          className="lab-chip"
          onClick={() => (library ? setPickerOpen((open) => !open) : uploadRef.current?.click())}
          disabled={secondDisabled}
          aria-expanded={library ? pickerOpen : undefined}
          title="The same swing from another camera — down the line with face-on, or face-on with down the line"
        >
          {secondAngleFileName ? "Replace second angle" : "Add second angle"}
        </button>
        {library && pickerOpen && !secondDisabled && (
          <SecondAnglePicker
            library={library}
            onPick={(file, id) => {
              setPickerOpen(false);
              onSecondAngle(file, id);
            }}
            onUpload={() => {
              setPickerOpen(false);
              uploadRef.current?.click();
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </span>
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

function SecondAnglePicker({
  library,
  onPick,
  onUpload,
  onClose,
}: {
  library: SecondAngleLibrary;
  onPick: (file: File, id: string) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const [clips, setClips] = useState<readonly SecondAngleClip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    library
      .list()
      .then((list) => live && setClips(list))
      .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      live = false;
    };
  }, [library]);

  const pick = async (clip: SecondAngleClip) => {
    setLoadingId(clip.id);
    setError(null);
    try {
      const loaded = await library.load(clip.id);
      onPick(new File([loaded.blob], loaded.name, { type: loaded.blob.type }), clip.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoadingId(null);
    }
  };

  return (
    <div className="lab-picker" role="dialog" aria-label="Choose the second angle">
      <div className="lab-picker-head">
        <strong>Second angle</strong>
        <button type="button" className="lab-chip" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="lab-panel-note">The same swing, filmed from the other camera.</p>
      {error && <p className="lab-panel-error">{error}</p>}
      {!clips && !error && <p className="lab-panel-note">Loading the library…</p>}
      {clips && clips.length === 0 && <p className="lab-panel-note">No other clips for this player.</p>}
      {clips && clips.length > 0 && (
        <ul className="lab-picker-list">
          {clips.map((clip) => (
            <li key={clip.id}>
              <button
                type="button"
                className="lab-picker-item"
                disabled={loadingId !== null}
                onClick={() => void pick(clip)}
              >
                {clip.thumbnail ? (
                  <img className="lab-picker-thumb" src={clip.thumbnail} alt="" />
                ) : (
                  <span className="lab-picker-thumb" aria-hidden="true" />
                )}
                <span className="lab-picker-text">
                  <span className="lab-picker-title">
                    {clip.title}
                    {clip.sameSwing && <span className="lab-picker-badge">Same swing</span>}
                  </span>
                  <span className="lab-picker-detail">
                    {loadingId === clip.id ? "Loading…" : clip.detail}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="lab-chip" onClick={onUpload} disabled={loadingId !== null}>
        Upload a file instead
      </button>
    </div>
  );
}

function HiddenFileInput({
  inputRef,
  onPick,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onPick: (file: File) => void;
}) {
  return (
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
      <HiddenFileInput inputRef={inputRef} onPick={onPick} />
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
