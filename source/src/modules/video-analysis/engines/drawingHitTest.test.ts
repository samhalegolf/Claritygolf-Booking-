import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DrawingEngine } from "./DrawingEngine";
import type { DrawingCircle, DrawingLine } from "../models/Drawing";

// The overlay is measured in pixels but objects are stored normalized, so every
// expectation below is "this many pixels into a 1000x500 picture".
const dimensions = { width: 1000, height: 500 };

const stamp = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const style = { color: "#9be8ba", strokeWidth: 2.4, opacity: 1, layer: 1 };

const line: DrawingLine = {
  id: "line-1",
  type: "line",
  x1: 0.2,
  y1: 0.2,
  x2: 0.8,
  y2: 0.2,
  ...style,
  ...stamp,
};

const circle: DrawingCircle = {
  id: "circle-1",
  type: "circle",
  cx: 0.5,
  cy: 0.5,
  rx: 0.1,
  ry: 0.2,
  ...style,
  ...stamp,
};

describe("hitTestObject", () => {
  it("picks the end a press is nearest, then the body", () => {
    assert.equal(DrawingEngine.hitTestObject(line, { x: 200, y: 100 }, dimensions), "start");
    assert.equal(DrawingEngine.hitTestObject(line, { x: 800, y: 100 }, dimensions), "end");
    assert.equal(DrawingEngine.hitTestObject(line, { x: 500, y: 100 }, dimensions), "move");
    assert.equal(DrawingEngine.hitTestObject(line, { x: 500, y: 300 }, dimensions), null);
  });

  it("gives a circle its interior for a plain press", () => {
    assert.equal(DrawingEngine.hitTestObject(circle, { x: 500, y: 250 }, dimensions), "move");
  });

  // With a drawing tool in hand, a press inside a circle has to stay available
  // for drawing -- circling the ball and then marking a line through it is the
  // whole point. The outline and the two size handles still pick it up.
  it("narrows a circle to its outline when only the stroke may be grabbed", () => {
    assert.equal(
      DrawingEngine.hitTestObject(circle, { x: 500, y: 250 }, dimensions, true),
      null
    );
    assert.equal(
      DrawingEngine.hitTestObject(circle, { x: 500, y: 350 }, dimensions, true),
      "radiusY"
    );
    assert.equal(
      DrawingEngine.hitTestObject(circle, { x: 600, y: 250 }, dimensions, true),
      "radiusX"
    );
  });

  it("leaves a line grabbable by its body either way", () => {
    assert.equal(DrawingEngine.hitTestObject(line, { x: 500, y: 100 }, dimensions, true), "move");
  });
});

describe("getObjectsAtPoint", () => {
  it("returns the topmost object under the point", () => {
    const overlapping: DrawingLine = { ...line, id: "line-2", y1: 0.205, y2: 0.205 };
    const hit = DrawingEngine.getObjectsAtPoint([line, overlapping], { x: 500, y: 100 }, dimensions);
    assert.equal(hit.object?.id, "line-2");
    assert.equal(hit.handle, "move");
  });

  it("reports nothing when the point is clear", () => {
    const hit = DrawingEngine.getObjectsAtPoint([line, circle], { x: 50, y: 450 }, dimensions);
    assert.equal(hit.object, null);
    assert.equal(hit.handle, null);
  });

  it("passes the stroke-only rule down to each object", () => {
    const inside = { x: 500, y: 250 };
    assert.equal(DrawingEngine.getObjectsAtPoint([circle], inside, dimensions).object?.id, "circle-1");
    assert.equal(DrawingEngine.getObjectsAtPoint([circle], inside, dimensions, true).object, null);
  });
});
