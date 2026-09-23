import React from "react";
import { DrawingTool } from "../models/Drawing";
import type { PhaseDetectionState } from "../hooks/useSwingPhaseMarkers";
import {
  IconFocus,
  IconPause,
  IconPlay,
  IconSettings,
  IconToolAngle,
  IconToolCircle,
  IconToolLine,
  IconToolPen,
  IconToolSelect,
  IconTrash,
  IconUndo,
} from "./VideoIcons";

// The player's half of the workspace chrome.
//
// The coach console is a console: every mode, tool and destination is on
// screen because a coach is at a desk with a mouse and uses all of them. A
// player is holding a phone, looking at one swing, and wants three things --
// move through it, mark one thing on it, send it. So this file is not a
// smaller Toolbar; it is a different shape:
//
//   - the rail of drawing tools is tucked off the video until asked for, and
//     while it is away the video surface is a scrubber rather than a canvas
//   - the button that fetches it sits on the video, in the corner the rail
//     comes out of, not out in the row of transport
//   - what is left is one row: step, play, step, and the send action
//
// Nothing here is a box around other boxes. The rail and the bar are surfaces
// the buttons sit on; the separators inside them are hairlines.

const TOOLS: { id: DrawingTool; label: string; icon: React.ReactNode }[] = [
  { id: "select", label: "Select", icon: <IconToolSelect /> },
  { id: "line", label: "Line", icon: <IconToolLine /> },
  { id: "angle", label: "Angle", icon: <IconToolAngle /> },
  { id: "circle", label: "Circle", icon: <IconToolCircle /> },
  { id: "pen", label: "Draw", icon: <IconToolPen /> },
];

/** The pencil glyph on the rail toggle. Its own icon rather than reusing the
 *  pen tool's, so "open the tools" never reads as "the pen is selected". */
const IconTools = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z" strokeLinejoin="round" />
    <path d="m13.5 6.5 4 4" />
  </svg>
);

export type PlayerToolRailToggleProps = {
  open: boolean;
  onToggle: () => void;
};

/**
 * The button that fetches the rail.
 *
 * It sits in the top-left corner of the video rather than out on the action
 * bar. Two reasons: it is the only bar control that acts on the picture
 * instead of the playhead, so it was the odd one out in a row of transport;
 * and on the coach console the bar sits on the app's white page card, where a
 * near-white icon button had nothing to read against. Over the video it has a
 * surface of its own, and it stands where the rail it opens comes out.
 */
export function PlayerToolRailToggle({ open, onToggle }: PlayerToolRailToggleProps) {
  return (
    <button
      type="button"
      className={`va-rail-toggle${open ? " is-active" : ""}`}
      aria-label={open ? "Hide drawing tools" : "Show drawing tools"}
      aria-pressed={open}
      onClick={onToggle}
    >
      <IconTools />
    </button>
  );
}

const IconStepBack = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M16 5 8 12l8 7V5Z" strokeLinejoin="round" />
    <path d="M5 5v14" strokeLinecap="round" />
  </svg>
);

const IconStepForward = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M8 5l8 7-8 7V5Z" strokeLinejoin="round" />
    <path d="M19 5v14" strokeLinecap="round" />
  </svg>
);

const IconSnapshot = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 8.5h3l1.5-2h7l1.5 2h3v10H4v-10Z" strokeLinejoin="round" />
    <circle cx="12" cy="13.5" r="3.2" />
  </svg>
);

export type PlayerToolRailProps = {
  open: boolean;
  selectedTool: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
  onUndo: () => void;
  canUndo: boolean;
  onClear: () => void;
  canClear: boolean;
  /** Coach-only. The player has no focus palette, so this stays unset there. */
  onFocusOpen?: () => void;
  /** Coach-only. The rail's half of the Space key: one button that takes the
   *  box if one has been dragged over the video, and the whole frame if not.
   *  It is also the only way to reach a capture from a tablet. */
  onCapture?: () => void;
  captureTooltip?: string;
};

/**
 * The rail, tucked against the edge of the video.
 *
 * It stays mounted while closed and slides out of frame instead: a rail that
 * unmounts would drop the tool you had selected back to the default every
 * time you looked at the swing without it. It is also an overlay rather than
 * a column in the layout, so opening it never resizes the video underneath.
 */
export function PlayerToolRail({
  open,
  selectedTool,
  onToolChange,
  onUndo,
  canUndo,
  onClear,
  canClear,
  onFocusOpen,
  onCapture,
  captureTooltip = "Screenshot (Space)",
}: PlayerToolRailProps) {
  return (
    <div
      className={`va-tool-rail${open ? " is-open" : ""}`}
      aria-hidden={!open}
      // A rail slid out of frame is still in the tree, so without this its
      // buttons stay tabbable and a screen reader still walks them.
      inert={!open}
    >
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className={`va-rail-btn${selectedTool === tool.id ? " is-active" : ""}`}
          aria-label={`${tool.label} tool`}
          aria-pressed={selectedTool === tool.id}
          onClick={() => onToolChange(tool.id)}
        >
          {tool.icon}
        </button>
      ))}
      <span className="va-rail-rule" aria-hidden="true" />
      <button
        type="button"
        className="va-rail-btn"
        aria-label="Undo"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <IconUndo />
      </button>
      <button
        type="button"
        className="va-rail-btn"
        aria-label="Clear markings"
        disabled={!canClear}
        onClick={onClear}
      >
        <IconTrash />
      </button>
      {onFocusOpen ? (
        <>
          <span className="va-rail-rule" aria-hidden="true" />
          <button
            type="button"
            className="va-rail-btn"
            aria-label="Focus palette"
            onClick={onFocusOpen}
          >
            <IconFocus />
          </button>
        </>
      ) : null}
      {onCapture ? (
        <>
          <span className="va-rail-rule" aria-hidden="true" />
          <button
            type="button"
            className="va-rail-btn"
            aria-label={captureTooltip}
            title={captureTooltip}
            onClick={onCapture}
          >
            <IconSnapshot />
          </button>
        </>
      ) : null}
    </div>
  );
}

const IconMarkers = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="4.5" r="1.8" />
    <path d="M12 7.5v6.5M7 10l5-1.5 5 1.5M12 14l-3.5 6M12 14l3.5 6" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="7" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="17" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="20" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="20" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

const IconGroundForce = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M8 3.5c2 0 3 1.8 3 4.3 0 2.2-.9 3.6-.9 5.6s.6 3.2.3 4.9c-.3 1.6-1.4 2.2-2.6 2.2S5.5 19.6 5.5 18c0-1.8.6-3 .3-5C5.4 11 5 9.7 5.2 7.6 5.5 5 6.6 3.5 8 3.5Z" />
    <path d="M16 3.5c-2 0-3 1.8-3 4.3 0 2.2.9 3.6.9 5.6s-.6 3.2-.3 4.9c.3 1.6 1.4 2.2 2.6 2.2s2.3-.9 2.3-2.5c0-1.8-.6-3-.3-5 .4-2 .8-3.3.6-5.4C18.5 5 17.4 3.5 16 3.5Z" />
    <path d="M7.5 15.5h1M15.5 15.5h1" strokeLinecap="round" />
  </svg>
);

/** Timeline ticks snapping onto a swing arc: "put the markers on the swing". */
const IconSwingPhases = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M4 15c2-7 6-10 8-10s6 3 8 10" strokeLinecap="round" />
    <path d="M4 20h16" strokeLinecap="round" />
    <path d="M6 17.5V20M12 17.5V20M18 17.5V20" strokeLinecap="round" />
    <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

const phaseTitle = (state: PhaseDetectionState) => {
  switch (state.kind) {
    case "running":
      return `Finding the swing… ${Math.round(state.progress * 100)}%`;
    case "failed":
      return `Swing not found: ${state.message}`;
    case "ready":
      return state.placed
        ? "Markers are on the swing. Press to snap them back."
        : "Snap the markers to the swing";
    default:
      return "Snap the markers to the swing";
  }
};

export type AnalysisRailProps = {
  /** Unset where the 3D lab cannot run (the native shell). */
  onOpen3D?: () => void;
  motionLabOpen: boolean;
  motionLabDisabled?: boolean;
  showMarkers: boolean;
  onToggleMarkers: () => void;
  showGroundForce: boolean;
  onToggleGroundForce: () => void;
  /** Moves every timeline marker onto the swing the lab found. */
  onSnapPhases?: () => void;
  phaseState?: PhaseDetectionState;
};

/**
 * The drawing rail's mirror on the right edge: the reads of the body rather
 * than marks on the picture. Always out -- three buttons do not need putting
 * away, and each is a state worth seeing at a glance.
 */
export function AnalysisRail({
  onOpen3D,
  motionLabOpen,
  motionLabDisabled,
  showMarkers,
  onToggleMarkers,
  showGroundForce,
  onToggleGroundForce,
  onSnapPhases,
  phaseState = { kind: "idle" },
}: AnalysisRailProps) {
  const phaseLabel = phaseTitle(phaseState);
  const running = phaseState.kind === "running";
  return (
    <div className="va-analysis-rail" role="toolbar" aria-label="Body analysis">
      {onOpen3D ? (
        <>
          <button
            type="button"
            className={`va-rail-btn va-rail-btn-3d${motionLabOpen ? " is-active" : ""}`}
            aria-label="3D motion"
            title="3D motion"
            aria-pressed={motionLabOpen}
            disabled={motionLabDisabled}
            onClick={onOpen3D}
          >
            3D
          </button>
          <span className="va-rail-rule" aria-hidden="true" />
        </>
      ) : null}
      <button
        type="button"
        className={`va-rail-btn${showMarkers ? " is-active" : ""}`}
        aria-label="Live body markers"
        title="Live body markers"
        aria-pressed={showMarkers}
        onClick={onToggleMarkers}
      >
        <IconMarkers />
      </button>
      <button
        type="button"
        className={`va-rail-btn${showGroundForce ? " is-active" : ""}`}
        aria-label="Ground force heat map"
        title="Ground force heat map"
        aria-pressed={showGroundForce}
        onClick={onToggleGroundForce}
      >
        <IconGroundForce />
      </button>
      {onSnapPhases ? (
        <>
          <span className="va-rail-rule" aria-hidden="true" />
          <button
            type="button"
            className={`va-rail-btn va-rail-btn-phases is-${phaseState.kind}`}
            aria-label={phaseLabel}
            title={phaseLabel}
            aria-busy={running}
            disabled={running}
            onClick={onSnapPhases}
            style={
              running
                ? ({ "--va-phase-progress": `${Math.round(phaseState.progress * 100)}%` } as React.CSSProperties)
                : undefined
            }
          >
            <IconSwingPhases />
          </button>
        </>
      ) : null}
    </div>
  );
}

export type PlayerActionBarProps = {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepFrame: (direction: -1 | 1) => void;
  onSave: () => void;
  onSend?: () => void;
  canSend: boolean;
  busy: boolean;
  saving: boolean;
  sending: boolean;
  status: string;
  statusTone: "idle" | "saved" | "error";
  /** Coach-only. Everything that isn't drawing or transport lives behind
   *  this gear, so it stays unset on the player's bar. */
  settingsOpen?: boolean;
  onSettingsToggle?: () => void;
};

/**
 * The one row of controls under the video.
 *
 * Transport sits centred under the picture because it is used constantly; the
 * destination sits right because it is used once. The save state is a line of text under the
 * row, not a third button and not a box.
 */
export function PlayerActionBar({
  isPlaying,
  onTogglePlay,
  onStepFrame,
  onSave,
  onSend,
  canSend,
  busy,
  saving,
  sending,
  status,
  statusTone,
  settingsOpen,
  onSettingsToggle,
}: PlayerActionBarProps) {
  return (
    <div className="va-player-bar">
      <div className="va-player-bar-row">
        <div className="va-transport">
          <button
            type="button"
            className="va-bar-btn"
            aria-label="Previous frame"
            onClick={() => onStepFrame(-1)}
          >
            <IconStepBack />
          </button>
          <button
            type="button"
            className="va-bar-btn is-play"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={onTogglePlay}
          >
            {isPlaying ? <IconPause /> : <IconPlay />}
          </button>
          <button
            type="button"
            className="va-bar-btn"
            aria-label="Next frame"
            onClick={() => onStepFrame(1)}
          >
            <IconStepForward />
          </button>
        </div>

        <div className="va-player-destinations">
          {onSettingsToggle ? (
            <button
              type="button"
              className={`va-bar-btn${settingsOpen ? " is-active" : ""}`}
              aria-label={settingsOpen ? "Hide settings" : "Show settings"}
              aria-pressed={Boolean(settingsOpen)}
              onClick={onSettingsToggle}
            >
              <IconSettings />
            </button>
          ) : null}
          <button type="button" className="va-bar-text-btn" onClick={onSave} disabled={busy}>
            {saving ? "Saving…" : "Save"}
          </button>
          {canSend && onSend ? (
            <button type="button" className="va-bar-send" onClick={onSend} disabled={busy}>
              {sending ? "Sending…" : "Send to coach"}
            </button>
          ) : null}
        </div>
      </div>
      {status ? (
        <p className={`va-player-status is-${statusTone}`} role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
