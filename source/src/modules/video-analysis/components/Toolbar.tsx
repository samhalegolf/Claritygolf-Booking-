import React from "react";
import { DrawingTool } from "../models/Drawing";
import { ToolButton } from "./ToolButton";
import {
  IconFocus,
  IconLinked,
  IconModeCompare,
  IconModeSingle,
  IconSync,
  IconToolAngle,
  IconToolCircle,
  IconToolLine,
  IconToolPen,
  IconToolSelect,
} from "./VideoIcons";

const iconForTool = (tool: DrawingTool): React.ReactNode => {
  switch (tool) {
    case "select":
      return <IconToolSelect />;
    case "line":
      return <IconToolLine />;
    case "angle":
      return <IconToolAngle />;
    case "circle":
      return <IconToolCircle />;
    case "pen":
      return <IconToolPen />;
  }
};

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
        icon={<IconModeSingle />}
        label="Single"
        tooltip="Single mode"
        active={mode === "single"}
        onClick={() => onModeChange("single")}
      />
      <ToolButton
        icon={<IconModeCompare />}
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
