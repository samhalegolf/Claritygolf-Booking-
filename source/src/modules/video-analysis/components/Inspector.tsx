import React from "react";
import { DrawingObject, DrawingTool } from "../models/Drawing";

interface InspectorProps {
  selectedTool: DrawingTool;
  selectedObject: DrawingObject | null;
  canUndo: boolean;
  canRedo: boolean;
  currentObjects: number;
}

export function Inspector({
  selectedTool,
  selectedObject,
  canUndo,
  canRedo,
  currentObjects,
}: InspectorProps) {
  return (
    <div className="inspector">
      <div>Tool: {selectedTool}</div>
      <div>Objects: {currentObjects}</div>
      <div>Undo: {canUndo ? "available" : "empty"}</div>
      <div>Redo: {canRedo ? "available" : "empty"}</div>
      <div style={{ gridColumn: "1 / -1" }}>
        Selected: {selectedObject ? selectedObject.id : "none"}
      </div>
    </div>
  );
}

