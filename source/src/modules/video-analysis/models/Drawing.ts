import { t } from "../../../lib/i18n";

export type DrawingTool = "select" | "line" | "angle" | "circle" | "pen";

/** The colours a marking can be drawn in, named as the reader sees them. The first is the default. */
export const DRAWING_COLORS: { value: string; label: string }[] = [
  { value: "#9be8ba", label: t("Mint") },
  { value: "#ffffff", label: t("White") },
  { value: "#ffd166", label: t("Yellow") },
  { value: "#ff6b6b", label: t("Red") },
  { value: "#5ec8ff", label: t("Blue") },
];

export const DEFAULT_DRAWING_COLOR = DRAWING_COLORS[0].value;

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
