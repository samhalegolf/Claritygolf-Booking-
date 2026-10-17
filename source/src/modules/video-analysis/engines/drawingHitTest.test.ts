import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DrawingEngine, TOUCH_REACH, hitReachFor } from "./DrawingEngine";
import type { DrawingAngle, DrawingCircle, DrawingLine } from "../models/Drawing";

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

  it("gives a circle its interior, outline and size handles", () => {
    assert.equal(DrawingEngine.hitTestObject(circle, { x: 500, y: 250 }, dimensions), "move");
    assert.equal(DrawingEngine.hitTestObject(circle, { x: 500, y: 350 }, dimensions), "radiusY");
    assert.equal(DrawingEngine.hitTestObject(circle, { x: 600, y: 250 }, dimensions), "radiusX");
  });

  // A fingertip hides the handle it is aiming for, so it gets more room to
  // miss by than a cursor does: 18px off a line end is a miss for a mouse and
  // a hit for a finger, and the same goes for the body of the line.
  it("reaches further for a finger than for a cursor", () => {
    const nearEnd = { x: 818, y: 100 };
    const nearBody = { x: 500, y: 109 };
    assert.equal(DrawingEngine.hitTestObject(line, nearEnd, dimensions), null);
    assert.equal(DrawingEngine.hitTestObject(line, nearEnd, dimensions, TOUCH_REACH), "end");
    assert.equal(DrawingEngine.hitTestObject(line, nearBody, dimensions), null);
    assert.equal(DrawingEngine.hitTestObject(line, nearBody, dimensions, TOUCH_REACH), "move");
  });

  it("picks the reach from the pointer type, with the mouse as the default", () => {
    assert.equal(hitReachFor("touch"), TOUCH_REACH);
    assert.equal(hitReachFor("mouse"), hitReachFor(undefined));
    assert.notEqual(hitReachFor("pen"), TOUCH_REACH);
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

  it("passes the reach down to each object", () => {
    const nearEnd = { x: 818, y: 100 };
    assert.equal(DrawingEngine.getObjectsAtPoint([line], nearEnd, dimensions).object, null);
    assert.equal(
      DrawingEngine.getObjectsAtPoint([line], nearEnd, dimensions, TOUCH_REACH).object?.id,
      "line-1"
    );
  });
});

describe("canFinishDraft", () => {
  it("drops a line or angle that a tap left with no length", () => {
    const dot: DrawingLine = { ...line, x2: line.x1, y2: line.y1 };
    assert.equal(DrawingEngine.canFinishDraft(dot), false);
    assert.equal(DrawingEngine.canFinishDraft(line), true);
    assert.equal(
      DrawingEngine.canFinishDraft({ ...dot, type: "angle", x3: 0.3, y3: 0.3 }),
      false
    );
  });
});

describe("angles", () => {
  // Vertex in the middle, first arm straight right. Normalized units differ
  // per axis on this 2:1 picture, which is the point: everything is judged
  // on screen.
  const angle: DrawingAngle = {
    id: "angle-1",
    type: "angle",
    x1: 0.5,
    y1: 0.5,
    x2: 0.7,
    y2: 0.5,
    x3: 0.5,
    y3: 0.5,
    ...style,
    ...stamp,
  };

  it("has no reading while the second arm is still at the vertex", () => {
    assert.equal(DrawingEngine.angleDegrees(angle, dimensions), null);
    assert.equal(DrawingEngine.canFinishDraft(angle), false);
    assert.equal(DrawingEngine.canOpenAngle(angle), true);
    assert.equal(DrawingEngine.canOpenAngle({ ...angle, x2: 0.5 }), false);
  });

  it("stands the second arm square to the first, on screen", () => {
    const opened = DrawingEngine.openAngleSecondArm(angle, dimensions);
    // A 200px arm turned a quarter turn is 200px straight down: 0.4 of the
    // 500px height, not 0.2 of it.
    assert.ok(Math.abs(opened.x3 - 0.5) < 1e-9);
    assert.ok(Math.abs(opened.y3 - 0.9) < 1e-9);
    assert.equal(Math.round(DrawingEngine.angleDegrees(opened, dimensions) ?? 0), 90);
    assert.equal(DrawingEngine.canFinishDraft(opened), true);
  });

  it("reads the angle the second arm is swung to", () => {
    const swung = DrawingEngine.updateAngleSecondArm(angle, { x: 200, y: 500 }, dimensions);
    assert.ok(Math.abs(swung.x3 - 0.2) < 1e-9 && Math.abs(swung.y3 - 1) < 1e-9);
    // Vertex at (500,250); second arm to (200,500) is 300 left, 250 down.
    const expected = (Math.atan2(250, -300) * 180) / Math.PI;
    assert.equal(
      Math.round(DrawingEngine.angleDegrees(swung, dimensions) ?? 0),
      Math.round(expected)
    );
  });

  it("draws new shapes in the colour in hand", () => {
    const made = DrawingEngine.createObject("line", { x: 10, y: 10 }, dimensions, "#ff6b6b");
    assert.equal(made.color, "#ff6b6b");
    assert.equal(DrawingEngine.createObject("line", { x: 10, y: 10 }, dimensions).color, style.color);
  });
});
