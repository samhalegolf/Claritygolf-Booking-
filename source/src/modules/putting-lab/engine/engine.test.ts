/**
 * The Putting Lab engine end to end, on synthetic frames: calibrate from the
 * template, lift it, putt with known face, path and start, and compare.
 *
 * These prove the maths and the pipeline, not the camera, the light or the
 * green; the lab's Validate mode does that on a real one.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { PuttingLabEngine } from "./engine";
import { apply3, radians, RigidTransform, solveHomography, Vec2 } from "./geometry";
import { CameraMovementTracker, type DeviceAttitude } from "./motion";
import type { PuttingStroke } from "./stroke";
import { SyntheticCamera, SyntheticPutt, SyntheticRenderer, type SyntheticScene } from "./synthetic.testkit";
import { BALL_DIAMETER_MM, TEMPLATE, templateSVG } from "./template";

const camera = new SyntheticCamera();
const renderer = new SyntheticRenderer(camera);

/** Feed a static scene at `fps`, fresh noise each frame, until `until` or time runs out. */
function feed(engine: PuttingLabEngine, scene: SyntheticScene, t0: number, seconds: number, fps = 30, until?: () => boolean, attitude?: DeviceAttitude) {
  const clean = renderer.render(scene);
  let t = t0;
  while (t < t0 + seconds) {
    engine.process(renderer.frame(clean), t, attitude ?? null);
    t += 1 / fps;
    if (until?.()) break;
  }
  return t;
}

function calibratedEngine(putt: SyntheticPutt, markers: boolean, plain = false) {
  const engine = new PuttingLabEngine();
  let t = feed(engine, { templateDown: true }, 0, 2, 30, () => engine.phase !== "findingTemplate");
  assert.equal(engine.phase, "placingBall", "template not found");
  t = feed(engine, { templateDown: true, ball: Vec2.zero }, t, 2, 30, () => engine.phase !== "placingBall");
  assert.equal(engine.phase, "placingPutter", "ball not confirmed");
  const calibrationPose = new RigidTransform(0, new Vec2(0, -BALL_DIAMETER_MM / 2));
  t = feed(engine, { templateDown: true, ball: Vec2.zero, putterPose: calibrationPose, putterMarkers: markers, plainHead: plain }, t, 2, 30, () => engine.phase !== "placingPutter");
  assert.equal(engine.phase, "removeTemplate", `putter not calibrated: ${engine.snapshot.prompt}`);
  t = feed(engine, {}, t, 2, 30, () => engine.phase !== "removeTemplate");
  assert.equal(engine.phase, "live");
  t = feed(engine, { ball: putt.ballRest, putterPose: putt.putterPose(0), putterMarkers: markers, plainHead: plain }, t, 1, 60);
  assert.equal(engine.snapshot.gate, "ready");
  assert.equal(engine.snapshot.putterStatus, "tracking", "putter not reacquired");
  return { engine, t };
}

/** Play the putt, rendering every frame. */
function play(engine: PuttingLabEngine, putt: SyntheticPutt, t0: number, markers: boolean, plain = false, fps = 120) {
  let stroke: PuttingStroke | null = null;
  engine.onStroke = (s) => {
    stroke = s;
  };
  for (let k = 0; k / fps < putt.impactTime + 0.7 && !stroke; k++) {
    const tp = k / fps;
    const scene = { ball: putt.ballPosition(tp), putterPose: putt.putterPose(tp), putterMarkers: markers, plainHead: plain };
    engine.process(renderer.frame(renderer.render(scene)), t0 + tp);
  }
  return stroke as PuttingStroke | null;
}

function assertMeasures(s: PuttingStroke, p: SyntheticPutt, t0: number, faceTol: number, pathTol: number) {
  const m = s.metrics;
  assert.ok(m.face && Math.abs(m.face.value - p.face) <= faceTol, `face ${m.face?.value} vs ${p.face}`);
  assert.ok(m.path && Math.abs(m.path.value - p.path) <= pathTol, `path ${m.path?.value} vs ${p.path}`);
  assert.ok(m.start && Math.abs(m.start.value - p.start) <= 0.15, `start ${m.start?.value} vs ${p.start}`);
  const truthSpeed = p.ballSpeed / 1000;
  assert.ok(m.ballSpeed && Math.abs(m.ballSpeed.value - truthSpeed) <= truthSpeed * 0.05, `speed ${m.ballSpeed?.value} vs ${truthSpeed}`);
  assert.ok(Math.abs(s.impact.time - t0 - p.impactTime) <= 0.003, `impact ${s.impact.time - t0} vs ${p.impactTime}`);
  assert.ok(m.strikePoint && Math.abs(m.strikePoint.value) <= 1.5, `strike ${m.strikePoint?.value}`);
  assert.ok(m.confidence > 0.4, `confidence ${m.confidence}`);
}

test("the homography recovers a camera from the template references", () => {
  const world = TEMPLATE.references.map((r) => r.position);
  const image = world.map((w) => apply3(camera.worldToImage, w)!);
  const h = solveHomography(image, world)!;
  const probe = new Vec2(60, 250);
  assert.ok(apply3(h, apply3(camera.worldToImage, probe)!)!.distance(probe) < 1e-6);
});

test("the printable sheet is the layout the detector looks for", () => {
  // Regenerate after a layout change with: PUTTING_LAB_WRITE_TEMPLATE=1 npm test
  const url = new URL("../../../../public/putting-lab/calibration-template-a3.svg", import.meta.url);
  if (process.env.PUTTING_LAB_WRITE_TEMPLATE === "1") writeFileSync(url, templateSVG());
  assert.equal(readFileSync(url, "utf8"), templateSVG(), "public/putting-lab/calibration-template-a3.svg is stale");
});

test("calibration solves the putting plane", () => {
  const engine = new PuttingLabEngine();
  feed(engine, { templateDown: true }, 0, 2, 30, () => engine.phase !== "findingTemplate");
  const surface = engine.snapshot.surface;
  assert.ok(surface);
  assert.ok(surface.reprojectionErrorMM < 0.4, `solve ${surface.reprojectionErrorMM}`);
  for (const p of [new Vec2(0, 0), new Vec2(80, -40), new Vec2(-60, 150), new Vec2(0, 260)]) {
    const pixel = apply3(camera.worldToImage, p)!;
    assert.ok(apply3(surface.imageToWorld, pixel)!.distance(p) < 0.35, `at ${p.x},${p.y}`);
  }
});

test("a markerless putt measures face, path, start and speed", () => {
  const putt = new SyntheticPutt();
  const { engine, t } = calibratedEngine(putt, false);
  assert.equal(engine.snapshot.trackingMode, "markerless");
  const stroke = play(engine, putt, t, false);
  assert.ok(stroke, "no stroke detected");
  assertMeasures(stroke, putt, t, 0.1, 0.2);
});

test("a putter with stickers switches to enhanced tracking and measures the putt", () => {
  const putt = new SyntheticPutt({ face: -0.8, path: 1.2, start: -0.5 });
  const { engine, t } = calibratedEngine(putt, true);
  assert.equal(engine.snapshot.trackingMode, "enhanced");
  const stroke = play(engine, putt, t, true);
  assert.ok(stroke, "no stroke detected");
  assertMeasures(stroke, putt, t, 0.1, 0.2);

  // Swinging the aim re-reads the same putt without recalibrating.
  const before = stroke.metrics;
  engine.setTarget({ aimOffset: radians(2.5), gates: [] });
  const after = engine.strokes[engine.strokes.length - 1].metrics;
  assert.ok(Math.abs(after.face!.value - (before.face!.value - 2.5)) < 1e-6);
  assert.ok(Math.abs(after.path!.value - (before.path!.value - 2.5)) < 1e-6);
  assert.ok(Math.abs(after.start!.value - (before.start!.value - 2.5)) < 1e-6);
  assert.ok(Math.abs(after.faceToPath!.value - before.faceToPath!.value) < 1e-6);
});

test("a plain black putter is tracked on its edge alone", () => {
  const putt = new SyntheticPutt({ face: -1.2, path: 0.3, start: -0.9 });
  const { engine, t } = calibratedEngine(putt, false, true);
  const stroke = play(engine, putt, t, false, true);
  assert.ok(stroke, "no stroke detected");
  assertMeasures(stroke, putt, t, 0.15, 0.25);
});

test("a firm putt at 30 frames a second still reads start, speed, face and path", () => {
  // The worst a phone browser delivers: the ball moves ~50 mm between frames.
  const putt = new SyntheticPutt({ face: 0.4, path: -1.5, start: 0.1, downswingSeconds: 0.25 });
  const { engine, t } = calibratedEngine(putt, false);
  const stroke = play(engine, putt, t, false, false, 30);
  assert.ok(stroke, "no stroke detected");
  const m = stroke.metrics;
  assert.ok(m.start && Math.abs(m.start.value - putt.start) <= 0.15, `start ${m.start?.value}`);
  assert.ok(m.face && Math.abs(m.face.value - putt.face) <= 0.3, `face ${m.face?.value}`);
  assert.ok(m.path && Math.abs(m.path.value - putt.path) <= 0.6, `path ${m.path?.value}`);
  const truthSpeed = putt.ballSpeed / 1000;
  assert.ok(m.ballSpeed && Math.abs(m.ballSpeed.value - truthSpeed) <= truthSpeed * 0.08, `speed ${m.ballSpeed?.value}`);
  assert.ok(Math.abs(stroke.impact.time - t - putt.impactTime) <= 0.01, `impact ${stroke.impact.time - t}`);
});

test("a nudge at address is not a putt", () => {
  const putt = new SyntheticPutt();
  const { engine, t: t0 } = calibratedEngine(putt, false);
  let strokes = 0;
  engine.onStroke = () => {
    strokes++;
  };
  let t = t0;
  for (let i = 0; i < 120; i++) {
    const scene = { ball: putt.ballRest.add(new Vec2(0, Math.min(15, i * 0.5))), putterPose: putt.putterPose(0) };
    engine.process(renderer.frame(renderer.render(scene)), t);
    t += 1 / 240;
  }
  assert.equal(strokes, 0);
});

test("moving the camera stops measurement until recalibrated", () => {
  const engine = new PuttingLabEngine();
  const flat: DeviceAttitude = { w: 1, x: 0, y: 0, z: 0, gravity: { x: 0, y: 0, z: -1 } };
  const t = feed(engine, { templateDown: true }, 0, 2, 30, () => engine.phase !== "findingTemplate", flat);
  assert.equal(engine.phase, "placingBall");
  const half = radians(1.5) / 2;
  const moved: DeviceAttitude = { w: Math.cos(half), x: Math.sin(half), y: 0, z: 0, gravity: { x: 0, y: 0, z: -1 } };
  feed(engine, { templateDown: true }, t, 0.01, 30, undefined, moved);
  assert.equal(engine.phase, "cameraMoved");
  engine.recalibrate();
  assert.equal(engine.phase, "findingTemplate");
});

test("slow sensor drift is not camera movement, a knock is", () => {
  const flat: DeviceAttitude = { w: 1, x: 0, y: 0, z: 0, gravity: { x: 0, y: 0, z: -1 } };
  const tracker = new CameraMovementTracker(flat, 0);
  const about = (deg: number): DeviceAttitude => ({ w: Math.cos(radians(deg) / 2), x: 0, y: 0, z: Math.sin(radians(deg) / 2), gravity: flat.gravity });
  let result = "still";
  let t = 0;
  for (; t < 600; t += 1 / 30) result = tracker.update(about((3 * t) / 600), t);
  assert.equal(result, "still");
  for (let i = 1; i <= 3; i++, t += 1 / 30) result = tracker.update(about(3 + i / 3), t);
  assert.equal(result, "moved");
});
