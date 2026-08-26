import React from "react";
import { DrawingTool } from "../models/Drawing";
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
