import React from "react";
import { DrawingTool } from "../models/Drawing";
import { ToolButton } from "./ToolButton";

const iconForTool = (tool: DrawingTool) => {
  switch (tool) {
    case "select":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M4 4l4.8 12.4L11 11l4.6-2.2L6 8.8 4 4zm0 0l6.2 2.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "line":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <line
            x1="3"
            y1="16"
            x2="17"
            y2="4"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
        </svg>
      );
    case "angle":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M3 14.5L8.5 5.5 16 11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "circle":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <ellipse
            cx="10"
            cy="10"
            rx="6"
            ry="4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
          />
        </svg>
      );
    case "pen":
      return (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M3.5 16.5l4.7-1.3 8.6-8.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <path
            d="M12.8 6.2l1.4-1.4 3.2 3.2-1.4 1.4-3.2-3.2z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
};

const IconFocus = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path
      d="M10 3l1.4 2.8L14 6l-2.6 1.4L10 10l-1.4-2.6L6 6l2.6-.2L10 3z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinejoin="round"
    />
    <path
      d="M4.5 16h11"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      opacity="0.75"
    />
  </svg>
);

const IconLinked = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path
      d="M5.8 10.2 7 9 11.5 4.5c1-1.4 2.8-1.5 3.9-.2 1.1 1.3 1 3.4-.2 4.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    <path
      d="M14 9.8 12.8 11c-1.4 1.3-3.4 1-4.2-.7-1-1.8-.4-4.2 1-5.3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    <path
      d="M6.9 11.1c-.7.3-1.3 0-1.5-.6-.2-.6 0-1.4.7-1.7.6-.3 1.3-.1 1.6.5.3.7 0 1.5-.8 1.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      opacity="0.7"
    />
  </svg>
);

const IconSync = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path
      d="M4 6h7.6M9.8 3.4 12 6 9.8 8.6M16 14H8.4M10.2 11.4 8 14l2.2 2.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface ToolbarProps {
  selected: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
  showAngleTool?: boolean;
  onFocusOpen: () => void;
  mode: "single" | "compare";
  onModeChange: (mode: "single" | "compare") => void;
  onLinkedPlaybackToggle: () => void;
  linkedPlayback: boolean;
  onSyncPlayheads: () => void;
  syncPlayheadsEnabled: boolean;
}

export function Toolbar({
  selected,
  onToolChange,
  showAngleTool,
  onFocusOpen,
  mode,
  onModeChange,
  onLinkedPlaybackToggle,
  linkedPlayback,
  onSyncPlayheads,
  syncPlayheadsEnabled,
}: ToolbarProps) {
  const uniqueTools = ["select", "line", "circle", "pen", ...(showAngleTool ? ["angle"] : [])] as DrawingTool[];

  return (
    <div className="video-toolbar-group">
      <ToolButton
        icon={<span aria-hidden="true">S</span>}
        label="Single"
        tooltip="Single mode"
        active={mode === "single"}
        onClick={() => onModeChange("single")}
      />
      <ToolButton
        icon={<span aria-hidden="true">C</span>}
        label="Compare"
        tooltip="Comparison mode"
        active={mode === "compare"}
        onClick={() => onModeChange("compare")}
      />
      <ToolButton
        icon={<IconLinked />}
        className="is-linked"
        label="Linked"
        tooltip="Toggle linked playback"
        active={linkedPlayback}
        onClick={onLinkedPlaybackToggle}
      />
      {mode === "compare" ? (
        <ToolButton
          icon={<IconSync />}
          label="Sync playheads"
          tooltip="Sync active side playhead to inactive side"
          disabled={!syncPlayheadsEnabled}
          onClick={onSyncPlayheads}
        />
      ) : null}
      {uniqueTools.map((tool) => (
        <ToolButton
          key={tool}
          icon={iconForTool(tool)}
          label={`${tool} tool`}
          tooltip={`${tool[0].toUpperCase()}${tool.slice(1)} tool`}
          active={selected === tool}
          onClick={() => onToolChange(tool)}
        />
      ))}
      <ToolButton
        icon={<IconFocus />}
        label="Focus"
        tooltip="Focus palette"
        onClick={onFocusOpen}
      />
    </div>
  );
}
