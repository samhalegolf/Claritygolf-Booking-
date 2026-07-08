export type DrawingTool = "select" | "line" | "angle" | "circle" | "pen";

export type DrawingHandle =
  | "move"
  | "start"
  | "end"
  | "center"
  | "radius"
  | "radiusX"
  | "radiusY"
  | "path";
// Keep legacy "radius" for backward compatibility with older serialized objects.

export interface DrawingPoint {
  x: number;
  y: number;
}

export interface DrawingObjectBase {
  id: string;
  type: "line" | "angle" | "circle" | "pen";
  color: string;
  strokeWidth: number;
  opacity: number;
  layer: number;
  createdAt: string;
  updatedAt: string;
}

export interface DrawingLine extends DrawingObjectBase {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DrawingAngle extends DrawingObjectBase {
  type: "angle";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}

export interface DrawingCircle extends DrawingObjectBase {
  type: "circle";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface DrawingPen extends DrawingObjectBase {
  type: "pen";
  points: DrawingPoint[];
}

export type DrawingObject = DrawingLine | DrawingAngle | DrawingCircle | DrawingPen;
