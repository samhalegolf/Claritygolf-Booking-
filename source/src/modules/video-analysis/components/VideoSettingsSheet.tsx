import React from "react";
import { WorkspaceMode } from "../utils/localPersistence";
import {
  CameraDevice,
  PreferredCamera,
  RecordingOrientation,
  describePreferredCamera,
  isPreferredCamera,
} from "../utils/cameraPreference";
import {
  IconCamera,
  IconDiagnostics,
  IconOrientation,
  IconLibrary,
  IconLinked,
  IconModeCompare,
  IconRecord,
  IconSync,
  IconTrash,
  IconUpload,
} from "./VideoIcons";

// Everything that used to sit in the coach's always-on toolbar and isn't
// drawing or transport -- comparison mode, linked playback, sync, screen
// recording, the permanent library save, diagnostics, and swapping the
// active clip -- lives here instead. One gear on the action bar opens it;
// closing it (backdrop tap, Escape, or the gear again) puts it away. Nothing
// here is a coach-only idea kept secret from the type: the player simply
// never gets a gear to open it from.
//
// Choosing the recording camera is the same kind of thing, and it lives here
// for the same reason: it is a decision the coach makes once about their
// workstation, not a control they should have to step past on the way to
// every recording. Video Settings picks the camera; Video Analysis records
// with it.

const ORIENTATION_CHOICES: ReadonlyArray<{
  value: RecordingOrientation;
  label: string;
  ratio: string;
}> = [
  { value: "portrait", label: "Portrait", ratio: "9:16" },
  { value: "landscape", label: "Landscape", ratio: "16:9" },
];

export type VideoSettingsSheetProps = {
  open: boolean;
  onClose: () => void;
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  linkedPlayback: boolean;
  onLinkedPlaybackToggle: () => void;
  onSyncPlayheads: () => void;
  syncPlayheadsEnabled: boolean;
  isRecordingScreen: boolean;
  screenRecordingBusy: boolean;
  screenRecordingMessage: string;
  onToggleScreenRecording: () => void;
  onMyLibrarySave: () => void;
  saveBusy: boolean;
  showDiagnostics: boolean;
  onToggleDiagnostics: () => void;
  activeSideLabel: string;
  hasActiveClip: boolean;
  onReplaceClip: () => void;
  onRecordReplacement: () => void;
  onClearClip: () => void;
  /** Video inputs the browser can see right now. */
  cameraDevices: MediaDeviceInfo[];
  /** The saved default, whether or not it is currently plugged in. */
  preferredCamera: PreferredCamera | null;
  /** The device the saved default resolves to now, or null when it is absent. */
  resolvedCamera: CameraDevice | null;
  cameraSupported: boolean;
  cameraLabelsAvailable: boolean;
  cameraError: string;
  onSelectCamera: (device: CameraDevice) => void;
  onRequestCameraLabels: () => void;
  /** Which way up the recording stage sits, and what the camera is asked for. */
  recordingOrientation: RecordingOrientation;
  onSelectOrientation: (orientation: RecordingOrientation) => void;
};

export function VideoSettingsSheet({
  open,
  onClose,
  mode,
  onModeChange,
  linkedPlayback,
  onLinkedPlaybackToggle,
  onSyncPlayheads,
  syncPlayheadsEnabled,
  isRecordingScreen,
  screenRecordingBusy,
  screenRecordingMessage,
  onToggleScreenRecording,
  onMyLibrarySave,
  saveBusy,
  showDiagnostics,
  onToggleDiagnostics,
  activeSideLabel,
  hasActiveClip,
  onReplaceClip,
  onRecordReplacement,
  onClearClip,
  cameraDevices,
  preferredCamera,
  resolvedCamera,
  cameraSupported,
  cameraLabelsAvailable,
  cameraError,
  onSelectCamera,
  onRequestCameraLabels,
  recordingOrientation,
  onSelectOrientation,
}: VideoSettingsSheetProps) {
  if (!open) return null;

  // A saved camera that is not in the list is still the coach's choice. It is
  // shown as its own selected row rather than dropped, so the setting reads as
  // "still yours, just not here right now" instead of silently emptying.
  const savedCameraMissing = Boolean(preferredCamera) && !resolvedCamera;

  return (
    <>
      <button
        type="button"
        className="va-sheet-backdrop"
        aria-label="Close settings"
        onClick={onClose}
      />
      <div className="va-sheet" role="dialog" aria-label="Video settings">
        <span className="va-sheet-handle" aria-hidden="true" />

        <section className="va-sheet-group va-camera-group" aria-labelledby="va-camera-heading">
          <h2 className="va-sheet-group-title" id="va-camera-heading">
            <IconCamera />
            <span>Camera</span>
          </h2>
          <p className="va-sheet-group-label" id="va-camera-choice-label">
            Default recording camera
          </p>

          {!cameraSupported ? (
            <p className="va-sheet-note">
              This browser cannot list cameras, so recording is unavailable here.
            </p>
          ) : (
            <div role="radiogroup" aria-labelledby="va-camera-choice-label">
              {savedCameraMissing ? (
                <span className="va-camera-option is-missing">
                  <span className="va-camera-dot is-on" aria-hidden="true" />
                  <span className="va-camera-name">
                    {describePreferredCamera(preferredCamera)}
                  </span>
                  <span className="va-camera-state">Not connected</span>
                </span>
              ) : null}

              {cameraDevices.map((device, index) => {
                const selected = !savedCameraMissing && isPreferredCamera(device, preferredCamera);
                return (
                  <button
                    key={device.deviceId || index}
                    type="button"
                    className={`va-camera-option va-camera-option-btn${selected ? " is-selected" : ""}`}
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      onSelectCamera({ deviceId: device.deviceId, label: device.label })
                    }
                  >
                    <span
                      className={`va-camera-dot${selected ? " is-on" : ""}`}
                      aria-hidden="true"
                    />
                    <span className="va-camera-name">
                      {device.label || `Camera ${index + 1}`}
                    </span>
                  </button>
                );
              })}

              {!cameraDevices.length ? (
                <p className="va-sheet-note">No cameras found.</p>
              ) : null}

              {!cameraLabelsAvailable ? (
                <button
                  type="button"
                  className="va-sheet-row va-sheet-row-btn"
                  onClick={onRequestCameraLabels}
                >
                  <IconCamera />
                  <span>Allow camera access to name your cameras</span>
                </button>
              ) : null}

              {cameraError ? (
                <p className="va-sheet-note" role="alert">
                  {cameraError}
                </p>
              ) : null}
            </div>
          )}
        </section>

        <span className="va-sheet-divider" aria-hidden="true" />

        <section className="va-sheet-group" aria-labelledby="va-orientation-heading">
          <h2 className="va-sheet-group-title" id="va-orientation-heading">
            <IconOrientation />
            <span>Orientation</span>
          </h2>
          <p className="va-sheet-group-label" id="va-orientation-label">
            Recording orientation
          </p>
          <div role="radiogroup" aria-labelledby="va-orientation-label">
            {ORIENTATION_CHOICES.map((choice) => {
              const selected = recordingOrientation === choice.value;
              return (
                <button
                  key={choice.value}
                  type="button"
                  className={`va-camera-option va-camera-option-btn${selected ? " is-selected" : ""}`}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onSelectOrientation(choice.value)}
                >
                  <span
                    className={`va-camera-dot${selected ? " is-on" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="va-camera-name">{choice.label}</span>
                  <span className="va-camera-ratio">{choice.ratio}</span>
                </button>
              );
            })}
          </div>
        </section>

        <span className="va-sheet-divider" aria-hidden="true" />

        <button
          type="button"
          className="va-sheet-row va-sheet-row-btn"
          aria-pressed={mode === "compare"}
          onClick={() => onModeChange(mode === "compare" ? "single" : "compare")}
        >
          <IconModeCompare />
          <span>Compare mode</span>
          <span className={`va-sheet-toggle${mode === "compare" ? " is-on" : ""}`} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="va-sheet-row va-sheet-row-btn"
          aria-pressed={linkedPlayback}
          onClick={onLinkedPlaybackToggle}
        >
          <IconLinked />
          <span>Linked playback</span>
          <span className={`va-sheet-toggle${linkedPlayback ? " is-on" : ""}`} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="va-sheet-row va-sheet-row-btn"
          onClick={onSyncPlayheads}
          disabled={!syncPlayheadsEnabled}
        >
          <IconSync />
          <span>Sync playheads</span>
        </button>

        {/* What to do with the clip that is loaded on the active side --
            swap it for a recording, swap it for a file, or take it away.
            All three need a clip to act on, so the whole group waits for
            one. A side with nothing on it is filled from its own panel,
            which is showing a drop zone and a record button precisely
            because it is empty; offering the same two here as well is how
            the console used to grow a second copy of everything. */}
        {hasActiveClip ? (
          <>
            <span className="va-sheet-divider" aria-hidden="true" />

            <button
              type="button"
              className="va-sheet-row va-sheet-row-btn"
              onClick={onRecordReplacement}
            >
              <IconRecord />
              <span>Record {activeSideLabel.toLowerCase()} clip</span>
            </button>
            <button type="button" className="va-sheet-row va-sheet-row-btn" onClick={onReplaceClip}>
              <IconUpload />
              <span>Replace {activeSideLabel.toLowerCase()} clip</span>
            </button>
            <button
              type="button"
              className="va-sheet-row va-sheet-row-btn va-sheet-row-danger"
              onClick={onClearClip}
            >
              <IconTrash />
              <span>Clear {activeSideLabel.toLowerCase()} clip</span>
            </button>
          </>
        ) : null}

        <span className="va-sheet-divider" aria-hidden="true" />

        <button
          type="button"
          className="va-sheet-row va-sheet-row-btn"
          onClick={onToggleScreenRecording}
          disabled={screenRecordingBusy}
        >
          <IconRecord className={isRecordingScreen ? "va-sheet-icon-recording" : undefined} />
          <span>{isRecordingScreen ? "Stop screen recording" : "Screen record"}</span>
        </button>
        {screenRecordingMessage ? <p className="va-sheet-note">{screenRecordingMessage}</p> : null}

        <button
          type="button"
          className="va-sheet-row va-sheet-row-btn"
          onClick={onMyLibrarySave}
          disabled={saveBusy}
        >
          <IconLibrary />
          <span>Save permanently to My Library</span>
        </button>

        <button
          type="button"
          className="va-sheet-row va-sheet-row-btn"
          aria-pressed={showDiagnostics}
          onClick={onToggleDiagnostics}
        >
          <IconDiagnostics />
          <span>Diagnostics</span>
          <span className={`va-sheet-toggle${showDiagnostics ? " is-on" : ""}`} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
