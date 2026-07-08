import { createId } from "../utils/frameMath";
import {
  DrawingHandle,
  DrawingLine,
  DrawingAngle,
  DrawingObject,
  DrawingCircle,
  DrawingPoint,
  DrawingPen,
  DrawingObjectBase,
  DrawingTool,
} from "../models/Drawing";

export interface Dimensions {
  width: number;
  height: number;
}

export const DEFAULT_STROKE = "#9be8ba";

const strokeDefault: Omit<DrawingObjectBase, "id" | "type" | "createdAt" | "updatedAt"> = {
  color: DEFAULT_STROKE,
  strokeWidth: 2.4,
  opacity: 1,
  layer: 1,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const toNormalized = (point: { x: number; y: number }, dimensions: Dimensions) => ({
  x: clamp01(point.x / dimensions.width),
  y: clamp01(point.y / dimensions.height),
});

const toScreen = (point: DrawingPoint, dimensions: Dimensions) => ({
  x: point.x * dimensions.width,
  y: point.y * dimensions.height,
});

const distToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
) => {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const vv = vx * vx + vy * vy;
  if (vv === 0) return Math.hypot(wx, wy);
  let t = (wx * vx + wy * vy) / vv;
  t = Math.min(1, Math.max(0, t));
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  return Math.hypot(px - cx, py - cy);
};

const updateTimestamp = (object: DrawingObject, now: string) => ({
  ...object,
  updatedAt: now,
});
const HANDLE_TOLERANCE_PX = 10;
const MOVE_BODY_TOLERANCE_PX = 6;
const CIRCLE_MOVE_TOLERANCE = 0.22;

export class DrawingEngine {
  static createObject(
    tool: Exclude<DrawingTool, "select">,
    startPoint: DrawingPoint,
    dimensions: Dimensions
  ): DrawingObject {
    const normalized = toNormalized(startPoint, dimensions);
    const now = new Date().toISOString();
    const base: Omit<DrawingObjectBase, "type" | "id"> = {
      ...strokeDefault,
      opacity: 1,
      createdAt: now,
      updatedAt: now,
    };

    switch (tool) {
      case "line":
        return {
          id: createId("line"),
          type: "line",
          x1: normalized.x,
          y1: normalized.y,
          x2: normalized.x,
          y2: normalized.y,
          ...base,
        };
      case "angle":
        return {
          id: createId("angle"),
          type: "angle",
          x1: normalized.x,
          y1: normalized.y,
          x2: normalized.x,
          y2: normalized.y,
          x3: normalized.x,
          y3: normalized.y,
          ...base,
        };
      case "circle":
        return {
          id: createId("circle"),
          type: "circle",
          cx: normalized.x,
          cy: normalized.y,
          rx: 0.002,
          ry: 0.002,
          ...base,
        };
      case "pen":
        return {
          id: createId("pen"),
          type: "pen",
          points: [normalized],
          ...base,
        };
      default:
        return {
          id: createId("line"),
          type: "line",
          x1: normalized.x,
          y1: normalized.y,
          x2: normalized.x,
          y2: normalized.y,
          ...base,
        };
    }
  }

  static updateDraftObject(
    draft: DrawingObject,
    cursor: DrawingPoint,
    dimensions: Dimensions
  ): DrawingObject {
    if (!draft || !dimensions.width || !dimensions.height) return draft;
    const normalized = toNormalized(cursor, dimensions);
    const now = new Date().toISOString();
    if (draft.type === "line") {
      return updateTimestamp(
        {
          ...draft,
          x2: normalized.x,
          y2: normalized.y,
          updatedAt: now,
        } as DrawingLine,
        now
      );
    }
    if (draft.type === "angle") {
      return updateTimestamp(
        {
          ...draft,
          x2: normalized.x,
          y2: normalized.y,
          x3: normalized.x + 0.06,
          y3: normalized.y + 0.06,
          updatedAt: now,
        } as DrawingAngle,
        now
      );
    }
    if (draft.type === "circle") {
      const center = { x: draft.cx * dimensions.width, y: draft.cy * dimensions.height };
      const dx = cursor.x - center.x;
      const dy = cursor.y - center.y;
      const rx = Math.abs(dx) / dimensions.width;
      const ry = Math.abs(dy) / dimensions.height;
      return updateTimestamp(
        {
          ...draft,
          rx: Math.max(0.005, rx),
          ry: Math.max(0.005, ry),
          updatedAt: now,
        } as DrawingCircle,
        now
      );
    }
    if (draft.type === "pen") {
      const next = [...draft.points, normalized];
      return updateTimestamp(
        { ...draft, points: next, updatedAt: now } as DrawingPen,
        now
      );
    }
    return draft;
  }

  static canFinishDraft(draft: DrawingObject): boolean {
    if (draft.type === "pen") return draft.points.length > 1;
    if (draft.type === "circle") return draft.rx > 0.002 && draft.ry > 0.002;
    return true;
  }

  static moveObject(object: DrawingObject, deltaX: number, deltaY: number): DrawingObject {
    const now = new Date().toISOString();
    if (object.type === "line") {
      return {
        ...object,
        x1: clamp01(object.x1 + deltaX),
        y1: clamp01(object.y1 + deltaY),
        x2: clamp01(object.x2 + deltaX),
        y2: clamp01(object.y2 + deltaY),
        updatedAt: now,
      };
    }
    if (object.type === "angle") {
      return {
        ...object,
        x1: clamp01(object.x1 + deltaX),
        y1: clamp01(object.y1 + deltaY),
        x2: clamp01(object.x2 + deltaX),
        y2: clamp01(object.y2 + deltaY),
        x3: clamp01(object.x3 + deltaX),
        y3: clamp01(object.y3 + deltaY),
        updatedAt: now,
      };
    }
    if (object.type === "circle") {
      return {
        ...object,
        cx: clamp01(object.cx + deltaX),
        cy: clamp01(object.cy + deltaY),
        updatedAt: now,
      };
    }
    const points = object.points.map((entry) => ({
      x: clamp01(entry.x + deltaX),
      y: clamp01(entry.y + deltaY),
    }));
    return updateTimestamp(
      {
        ...object,
        points,
        updatedAt: now,
      },
      now
    );
  }

  static hitTestObject(
    object: DrawingObject,
    cursor: DrawingPoint,
    dimensions: Dimensions
  ): DrawingHandle | null {
    const px = cursor.x;
    const py = cursor.y;
    if (object.type === "line") {
      const p1 = toScreen({ x: object.x1, y: object.y1 }, dimensions);
      const p2 = toScreen({ x: object.x2, y: object.y2 }, dimensions);
      const startDistance = Math.hypot(px - p1.x, py - p1.y);
      const endDistance = Math.hypot(px - p2.x, py - p2.y);
      if (startDistance <= HANDLE_TOLERANCE_PX) return "start";
      if (endDistance <= HANDLE_TOLERANCE_PX) return "end";
      if (distToSegment(px, py, p1.x, p1.y, p2.x, p2.y) <= MOVE_BODY_TOLERANCE_PX) return "move";
      return null;
    }
    if (object.type === "angle") {
      const p1 = toScreen({ x: object.x1, y: object.y1 }, dimensions);
      const p2 = toScreen({ x: object.x2, y: object.y2 }, dimensions);
      const p3 = toScreen({ x: object.x3, y: object.y3 }, dimensions);
      // p1 is the angle vertex; p2/p3 are the two arm endpoints. Handle names
      // must match what transformObject moves: center=vertex, start/end=arms.
      if (Math.hypot(px - p1.x, py - p1.y) <= HANDLE_TOLERANCE_PX) return "center";
      if (Math.hypot(px - p2.x, py - p2.y) <= HANDLE_TOLERANCE_PX) return "start";
      if (Math.hypot(px - p3.x, py - p3.y) <= HANDLE_TOLERANCE_PX) return "end";
      if (distToSegment(px, py, p1.x, p1.y, p2.x, p2.y) <= MOVE_BODY_TOLERANCE_PX) return "move";
      if (distToSegment(px, py, p1.x, p1.y, p3.x, p3.y) <= MOVE_BODY_TOLERANCE_PX) return "move";
      return null;
    }
    if (object.type === "circle") {
      const center = toScreen({ x: object.cx, y: object.cy }, dimensions);
      const rx = object.rx * dimensions.width;
      const ry = object.ry * dimensions.height;
      const dx = px - center.x;
      const dy = py - center.y;
      const dist = Math.hypot(dx / Math.max(0.0001, rx), dy / Math.max(0.0001, ry));
      const handleRadiusPx = HANDLE_TOLERANCE_PX + 2;
      const rightHandle = { x: center.x + rx, y: center.y };
      const bottomHandle = { x: center.x, y: center.y + ry };
      if (Math.hypot(px - rightHandle.x, py - rightHandle.y) <= handleRadiusPx) return "radiusX";
      if (Math.hypot(px - bottomHandle.x, py - bottomHandle.y) <= handleRadiusPx) return "radiusY";
      if (Math.abs(dist - 1) <= CIRCLE_MOVE_TOLERANCE) return "radius";
      if (dist < 1 - CIRCLE_MOVE_TOLERANCE) return "move";
      return null;
    }
    if (object.type === "pen") {
      for (let i = 1; i < object.points.length; i += 1) {
        const a = toScreen(object.points[i - 1], dimensions);
        const b = toScreen(object.points[i], dimensions);
        if (distToSegment(px, py, a.x, a.y, b.x, b.y) <= MOVE_BODY_TOLERANCE_PX) return "path";
      }
      return null;
    }
    return null;
  }

  static transformObject(
    object: DrawingObject,
    handle: DrawingHandle,
    cursor: DrawingPoint,
    startCursor: DrawingPoint,
    dimensions: Dimensions
  ): DrawingObject {
    const now = new Date().toISOString();
    const point = toNormalized(cursor, dimensions);
    const baseCursor = toNormalized(startCursor, dimensions);
    const deltaX = point.x - baseCursor.x;
    const deltaY = point.y - baseCursor.y;
    if (object.type === "line") {
      if (handle === "start") {
        return updateTimestamp(
          {
            ...object,
            x1: point.x,
            y1: point.y,
            updatedAt: now,
          },
          now
        );
      }
      if (handle === "end") {
        return updateTimestamp(
          {
            ...object,
            x2: point.x,
            y2: point.y,
            updatedAt: now,
          },
          now
        );
      }
      return updateTimestamp(
        {
          ...object,
          x1: clamp01(object.x1 + deltaX),
          y1: clamp01(object.y1 + deltaY),
          x2: clamp01(object.x2 + deltaX),
          y2: clamp01(object.y2 + deltaY),
          updatedAt: now,
        },
        now
      );
    }
    if (object.type === "angle") {
      // Vertex handle: move only the corner point to the cursor.
      if (handle === "center") {
        return updateTimestamp(
          {
            ...object,
            x1: clamp01(point.x),
            y1: clamp01(point.y),
            updatedAt: now,
          },
          now
        );
      }
      // First arm endpoint.
      if (handle === "start") {
        return updateTimestamp(
          {
            ...object,
            x2: clamp01(point.x),
            y2: clamp01(point.y),
            updatedAt: now,
          },
          now
        );
      }
      // Second arm endpoint.
      if (handle === "end") {
        return updateTimestamp(
          {
            ...object,
            x3: clamp01(point.x),
            y3: clamp01(point.y),
            updatedAt: now,
          },
          now
        );
      }
      return updateTimestamp(
        {
          ...object,
          x1: clamp01(object.x1 + deltaX),
          y1: clamp01(object.y1 + deltaY),
          x2: clamp01(object.x2 + deltaX),
          y2: clamp01(object.y2 + deltaY),
          x3: clamp01(object.x3 + deltaX),
          y3: clamp01(object.y3 + deltaY),
          updatedAt: now,
        },
        now
      );
    }
    if (object.type === "circle") {
      if (handle === "radius") {
        const point = toNormalized(cursor, dimensions);
        const rx = Math.max(0.005, Math.abs(point.x - object.cx));
        const ry = Math.max(0.005, Math.abs(point.y - object.cy));
        return updateTimestamp(
          {
            ...object,
            rx,
            ry,
            updatedAt: now,
          },
          now
        );
      }
      if (handle === "radiusX") {
        const point = toNormalized(cursor, dimensions);
        return updateTimestamp(
          {
            ...object,
            rx: Math.max(0.005, Math.abs(point.x - object.cx)),
            updatedAt: now,
          },
          now
        );
      }
      if (handle === "radiusY") {
        const point = toNormalized(cursor, dimensions);
        return updateTimestamp(
          {
            ...object,
            ry: Math.max(0.005, Math.abs(point.y - object.cy)),
            updatedAt: now,
          },
          now
        );
      }
      return updateTimestamp(
        {
          ...object,
          cx: clamp01(object.cx + deltaX),
          cy: clamp01(object.cy + deltaY),
          updatedAt: now,
        },
        now
      );
    }
    if (object.type === "pen") {
      const moved = object.points.map((point) => ({
        x: clamp01(point.x + deltaX),
        y: clamp01(point.y + deltaY),
      }));
      return updateTimestamp(
        {
          ...object,
          points: moved,
          updatedAt: now,
        },
        now
      );
    }
    return object;
  }

  static getObjectsAtPoint(
    objects: DrawingObject[],
    cursorPx: DrawingPoint,
    dimensions: Dimensions
  ): { object: DrawingObject | null; handle: DrawingHandle | null } {
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      const object = objects[index];
      const handle = this.hitTestObject(object, cursorPx, dimensions);
      if (handle) {
        return { object, handle };
      }
    }
    return { object: null, handle: null };
  }
}
