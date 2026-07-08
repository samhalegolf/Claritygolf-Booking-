import React from "react";
import { ToolButton } from "./ToolButton";

interface FocusPaletteProps {
  onSelectArea: () => void;
  onSelectTrack: () => void;
  onClose: () => void;
}

export function FocusPalette({
  onSelectArea,
  onSelectTrack,
  onClose,
}: FocusPaletteProps) {
  return (
    <div className="focus-palette">
      <ToolButton
        icon={<span aria-hidden="true" style={{ fontSize: 14 }}>◯</span>}
        label="Area Focus"
        tooltip="Area Focus"
        onClick={() => {
          onSelectArea();
          onClose();
        }}
      />
      <ToolButton
        icon={(
          <span className="focus-beta-icon" aria-hidden="true">
            <span style={{ fontSize: 14 }}>⎈</span>
            <span className="focus-beta-mark" aria-hidden="true">
              β
            </span>
          </span>
        )}
        label="Track Focus Beta"
        tooltip="Track Focus Beta"
        onClick={() => {
          onSelectTrack();
          onClose();
        }}
      />
    </div>
  );
}
