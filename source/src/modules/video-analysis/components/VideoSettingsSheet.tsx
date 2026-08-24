import React from "react";
import { WorkspaceMode } from "../utils/localPersistence";
import {
  IconDiagnostics,
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
}: VideoSettingsSheetProps) {
  if (!open) return null;

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
        {hasActiveClip ? (
          <button
            type="button"
            className="va-sheet-row va-sheet-row-btn va-sheet-row-danger"
            onClick={onClearClip}
          >
            <IconTrash />
            <span>Clear {activeSideLabel.toLowerCase()} clip</span>
          </button>
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
