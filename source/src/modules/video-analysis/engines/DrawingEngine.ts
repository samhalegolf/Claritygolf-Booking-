import { createId } from "../utils/frameMath";
import {
  DEFAULT_DRAWING_COLOR,
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

const strokeDefault: Omit<DrawingObjectBase, "id" | "type" | "createdAt" | "updatedAt"> = {
  color: DEFAULT_DRAWING_COLOR,
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
const CIRCLE_MOVE_TOLERANCE = 0.22;
// In normalized picture units: about 3px of travel on a 1000px wide frame.
const MIN_DRAFT_LENGTH = 0.003;

/**
 * How close a press has to land to pick something up, in pixels.
 *
 * A fingertip covers far more of the picture than a cursor does and cannot
 * see what is under it, so it gets roughly double the reach: a handle can be
 * found by feel, and a tap meant for a line does not have to be pixel-exact.
 */
export interface HitReach {
  /** Around an endpoint, vertex or size handle. */
  handle: number;
  /** Either side of a line body or pen stroke. */
  body: number;
}

export const MOUSE_REACH: HitReach = { handle: 10, body: 6 };
export const TOUCH_REACH: HitReach = { handle: 22, body: 12 };

export const hitReachFor = (pointerType?: string): HitReach =>
  pointerType === "touch" ? TOUCH_REACH : MOUSE_REACH;

export class DrawingEngine {
  static createObject(
    tool: Exclude<DrawingTool, "select">,
    startPoint: DrawingPoint,
    dimensions: Dimensions,
    color: string = DEFAULT_DRAWING_COLOR
  ): DrawingObject {
    const normalized = toNormalized(startPoint, dimensions);
    const now = new Date().toISOString();
    const base: Omit<DrawingObjectBase, "type" | "id"> = {
      ...strokeDefault,
      color,
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
      // Drawing an angle starts as drawing a line: the first arm. The second
      // arm is not placed yet and stays at the vertex, where it has no length
      // and so no reading.
      return updateTimestamp(
        {
          ...draft,
          x2: normalized.x,
          y2: normalized.y,
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

  /**
   * Whether a release would leave something worth keeping. A press that never
   * travelled makes a shape with no size: invisible, undoable only by someone
   * who knows it is there, and saved with the analysis all the same.
   */
  static canFinishDraft(draft: DrawingObject): boolean {
    if (draft.type === "pen") return draft.points.length > 1;
    if (draft.type === "circle") return draft.rx > 0.002 && draft.ry > 0.002;
    if (draft.type === "angle") {
      return (
        Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > MIN_DRAFT_LENGTH &&
        Math.hypot(draft.x3 - draft.x1, draft.y3 - draft.y1) > MIN_DRAFT_LENGTH
      );
    }
    return Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > MIN_DRAFT_LENGTH;
  }

  /** Whether the first arm has been drawn far enough to give the angle a vertex and a direction. */
  static canOpenAngle(draft: DrawingAngle): boolean {
    return Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > MIN_DRAFT_LENGTH;
  }

  /**
   * The first arm is down; stand the second one up so there is an angle to
   * see and to take hold of. It starts square to the first arm, on screen
   * rather than in normalized units, so it looks square whatever the
   * picture's shape. A cursor overrides it on the next movement; a finger
   * on the next press.
   */
  static openAngleSecondArm(draft: DrawingAngle, dimensions: Dimensions): DrawingAngle {
    const vertex = toScreen({ x: draft.x1, y: draft.y1 }, dimensions);
    const first = toScreen({ x: draft.x2, y: draft.y2 }, dimensions);
    const dx = first.x - vertex.x;
    const dy = first.y - vertex.y;
    const second = toNormalized({ x: vertex.x - dy, y: vertex.y + dx }, dimensions);
    const now = new Date().toISOString();
    return { ...draft, x3: second.x, y3: second.y, updatedAt: now };
  }

  static updateAngleSecondArm(
    draft: DrawingAngle,
    cursor: DrawingPoint,
    dimensions: Dimensions
  ): DrawingAngle {
    const point = toNormalized(cursor, dimensions);
    const now = new Date().toISOString();
    return { ...draft, x3: point.x, y3: point.y, updatedAt: now };
  }

  /**
   * The angle between the two arms at the vertex, in degrees from 0 to 180,
   * measured on screen so a 90 reads as a right angle whatever the picture's
   * aspect. Null while either arm is too short to point anywhere.
   */
  static angleDegrees(angle: DrawingAngle, dimensions: Dimensions): number | null {
    const vertex = toScreen({ x: angle.x1, y: angle.y1 }, dimensions);
    const a = toScreen({ x: angle.x2, y: angle.y2 }, dimensions);
    const b = toScreen({ x: angle.x3, y: angle.y3 }, dimensions);
    const ax = a.x - vertex.x;
    const ay = a.y - vertex.y;
    const bx = b.x - vertex.x;
    const by = b.y - vertex.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1 || lb < 1) return null;
    const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
    return (Math.acos(cos) * 180) / Math.PI;
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

  /**
   * What, if anything, is under the cursor on this object.
   *
   * Only the select tool asks. A drawing tool always draws, even on top of a
   * shape, so a circle may claim its whole interior here: nothing is lost by
   * it, and a press inside the circle is the natural way to move it.
   */
  static hitTestObject(
    object: DrawingObject,
    cursor: DrawingPoint,
    dimensions: Dimensions,
    reach: HitReach = MOUSE_REACH
  ): DrawingHandle | null {
    const px = cursor.x;
    const py = cursor.y;
    const handleReach = reach.handle;
    const bodyReach = reach.body;
    if (object.type === "line") {
      const p1 = toScreen({ x: object.x1, y: object.y1 }, dimensions);
      const p2 = toScreen({ x: object.x2, y: object.y2 }, dimensions);
      const startDistance = Math.hypot(px - p1.x, py - p1.y);
      const endDistance = Math.hypot(px - p2.x, py - p2.y);
      if (startDistance <= handleReach) return "start";
      if (endDistance <= handleReach) return "end";
      if (distToSegment(px, py, p1.x, p1.y, p2.x, p2.y) <= bodyReach) return "move";
      return null;
    }
    if (object.type === "angle") {
      const p1 = toScreen({ x: object.x1, y: object.y1 }, dimensions);
      const p2 = toScreen({ x: object.x2, y: object.y2 }, dimensions);
      const p3 = toScreen({ x: object.x3, y: object.y3 }, dimensions);
      // p1 is the angle vertex; p2/p3 are the two arm endpoints. Handle names
      // must match what transformObject moves: center=vertex, start/end=arms.
      if (Math.hypot(px - p1.x, py - p1.y) <= handleReach) return "center";
      if (Math.hypot(px - p2.x, py - p2.y) <= handleReach) return "start";
      if (Math.hypot(px - p3.x, py - p3.y) <= handleReach) return "end";
      if (distToSegment(px, py, p1.x, p1.y, p2.x, p2.y) <= bodyReach) return "move";
      if (distToSegment(px, py, p1.x, p1.y, p3.x, p3.y) <= bodyReach) return "move";
      return null;
    }
    if (object.type === "circle") {
      const center = toScreen({ x: object.cx, y: object.cy }, dimensions);
      const rx = object.rx * dimensions.width;
      const ry = object.ry * dimensions.height;
      const dx = px - center.x;
      const dy = py - center.y;
      const dist = Math.hypot(dx / Math.max(0.0001, rx), dy / Math.max(0.0001, ry));
      const handleRadiusPx = handleReach + 2;
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
        if (distToSegment(px, py, a.x, a.y, b.x, b.y) <= bodyReach) return "path";
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
    dimensions: Dimensions,
    reach: HitReach = MOUSE_REACH
  ): { object: DrawingObject | null; handle: DrawingHandle | null } {
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      const object = objects[index];
      const handle = this.hitTestObject(object, cursorPx, dimensions, reach);
      if (handle) {
        return { object, handle };
      }
    }
    return { object: null, handle: null };
  }
}
