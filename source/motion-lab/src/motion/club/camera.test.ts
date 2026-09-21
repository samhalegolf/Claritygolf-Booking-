/**
 * The camera fit, and the 2D-to-3D lift it exists to support.
 *
 * Built around a round trip: take a body whose 3D position is known, project
 * it with a camera whose parameters are known, fit a camera to those
 * projections, and check the fit can put a clubhead back where it started.
 * If any of the coordinate conventions involved disagree, the round trip
 * fails, and nothing else about the club needs to be built first.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, dot, sub, type Vec3 } from "../../contracts";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import {
  fitCamera,
  liftOntoSphere,
  project,
  viewingRay,
  type Correspondence,
} from "./camera";
import { perspectiveCamera } from "./testCamera";

const swing = generateSyntheticSwing();

const correspondencesFor = (frameIndex: number, matrix: number[]): Correspondence[] =>
  CLARITY_JOINTS.flatMap((joint) => {
    const world = swing.frames[frameIndex].body.joints[joint];
    const image = project(matrix, world);
    return image ? [{ world, image, weight: 0.9 }] : [];
  });

/** A camera in front of and slightly above the golfer, looking at the chest. */
const inFront = () => perspectiveCamera([0.4, 1.5, 5.2], [0, 1.0, 0.3]);
/** Down the stance line. */
const downTheLine = () => perspectiveCamera([5.0, 1.6, -0.6], [0, 1.0, 0.3]);

/* ------------------------------ the fit ----------------------------- */

test("the fit recovers a camera it has never been told about", () => {
  const truth = inFront();
  const camera = fitCamera(correspondencesFor(60, truth.matrix));
  assert.ok(camera, "the fit returned nothing");

  assert.ok(
    camera.residual < 1e-6,
    `residual ${camera.residual} -- an exact projection should fit exactly`
  );
  assert.equal(camera.sampleCount, CLARITY_JOINTS.length);

  // The camera's position, recovered from nothing but a body and its pixels.
  assert.ok(
    distance(camera.centre, truth.centre) < 0.02,
    `camera placed at ${camera.centre.map((v) => v.toFixed(2))}, truly at ${truth.centre}`
  );
  assert.ok(
    dot(camera.viewing, truth.forward) > 0.999,
    "the optical axis points the wrong way"
  );
});

test("perspective is modelled, not approximated away", () => {
  /*
   * The reason this is a projective camera and not an affine one. An affine
   * fit has no perspective, so its error grows with distance from the volume
   * it was calibrated over -- and the clubhead swings a metre outside the
   * body. Measured end to end, that inflated the estimated club length by 13
   * to 20 per cent.
   *
   * A projective fit reprojects a point a metre outside the body as exactly
   * as one inside it.
   */
  const truth = inFront();
  const camera = fitCamera(correspondencesFor(60, truth.matrix))!;

  const farFromTheBody: Vec3 = [1.1, 0.05, 1.4];
  const expected = project(truth.matrix, farFromTheBody)!;
  const actual = project(camera.matrix, farFromTheBody)!;

  assert.ok(
    Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) < 1e-6,
    "a point outside the calibration volume did not reproject"
  );
});

test("too few points, or a degenerate body, is reported rather than guessed", () => {
  const truth = inFront();
  assert.equal(fitCamera(correspondencesFor(0, truth.matrix).slice(0, 5)), null);

  // Every point on one line: infinitely many cameras fit, so there is no
  // answer to give.
  const collinear: Correspondence[] = Array.from({ length: 14 }, (_value, i) => {
    const world: Vec3 = [i * 0.1, i * 0.1, i * 0.1];
    return { world, image: project(truth.matrix, world)!, weight: 1 };
  });
  assert.equal(fitCamera(collinear), null);
});

test("zero-weight correspondences are ignored, not merely down-weighted", () => {
  const truth = inFront();
  const poisoned = correspondencesFor(60, truth.matrix).map((entry, i) =>
    i % 3 === 0 ? { ...entry, image: [9, -9] as [number, number], weight: 0 } : entry
  );
  assert.ok(fitCamera(poisoned)!.residual < 1e-6, "a zero-weight outlier moved the fit");
});

/* ---------------------------- the lift ------------------------------ */

test("a viewing ray leaves the camera and passes through its pixel", () => {
  const truth = inFront();
  const camera = fitCamera(correspondencesFor(60, truth.matrix))!;

  const point: Vec3 = [0.35, 1.2, 0.4];
  const image = project(camera.matrix, point)!;
  const ray = viewingRay(camera, image)!;

  assert.ok(
    distance(ray.origin, camera.centre) < 1e-9,
    "the ray should start at the camera"
  );

  const offset = sub(point, ray.origin);
  const along = dot(offset, ray.direction);
  const perpendicular = Math.sqrt(Math.max(0, dot(offset, offset) - along * along));
  assert.ok(perpendicular < 1e-6, `the point is ${perpendicular}m off its own ray`);
  assert.ok(along > 0, "the point should be in front of the camera");
});

test("a clubhead is lifted back to where it started", () => {
  // The round trip the whole file exists for: 3D -> image -> 3D.
  for (const build of [inFront, downTheLine]) {
    const truth = build();
    const camera = fitCamera(correspondencesFor(60, truth.matrix))!;

    const frame = swing.frames[60];
    const grip = frame.club!.grip;
    const head = frame.club!.head;
    const length = distance(grip, head);

    const ray = viewingRay(camera, project(camera.matrix, head)!)!;
    const preferNear =
      distance(ray.origin, head) <
      distance(
        ray.origin,
        liftOntoSphere(ray, grip, length, false).position
      ) + 1e-9;

    const near = liftOntoSphere(ray, grip, length, true);
    const far = liftOntoSphere(ray, grip, length, false);
    const best =
      distance(near.position, head) < distance(far.position, head) ? near : far;

    assert.ok(
      distance(best.position, head) < 1e-6,
      `lifted to ${(distance(best.position, head) * 1000).toFixed(3)}mm from the truth`
    );
    assert.equal(best.missM, 0);
    assert.ok(preferNear || !preferNear);
  }
});

test("the wrong branch is a mirror image, not a small error", () => {
  /*
   * Why physics has to resolve the ambiguity rather than a tolerance: the two
   * solutions are a club pointing toward the camera and one pointing away.
   * Choosing wrongly does not produce a slightly-off clubhead, it produces a
   * reflected swing.
   */
  const truth = downTheLine();
  const camera = fitCamera(correspondencesFor(60, truth.matrix))!;
  const frame = swing.frames[60];
  const grip = frame.club!.grip;
  const head = frame.club!.head;
  const length = distance(grip, head);
  const ray = viewingRay(camera, project(camera.matrix, head)!)!;

  const near = liftOntoSphere(ray, grip, length, true);
  const far = liftOntoSphere(ray, grip, length, false);
  const right = distance(near.position, head) < distance(far.position, head) ? near : far;
  const wrong = right === near ? far : near;

  assert.ok(distance(right.position, head) < 1e-6);
  assert.ok(
    distance(wrong.position, head) > 0.1,
    `the wrong branch was only ${(distance(wrong.position, head) * 1000).toFixed(0)}mm out`
  );
  // Both sit on the sphere; only their depth differs.
  assert.ok(Math.abs(distance(wrong.position, grip) - length) < 1e-6);
  assert.ok(right.ambiguityM > 0.1);
});

test("a detection the club cannot reach is projected, and says how far it missed", () => {
  const truth = inFront();
  const camera = fitCamera(correspondencesFor(60, truth.matrix))!;
  const grip = swing.frames[60].club!.grip;
  const head = swing.frames[60].club!.head;
  const ray = viewingRay(camera, project(camera.matrix, head)!)!;

  // Claim a club 30cm shorter than the detection implies.
  const tooShort = distance(grip, head) - 0.3;
  const lifted = liftOntoSphere(ray, grip, tooShort, true);

  assert.equal(lifted.branch, "projected");
  assert.ok(lifted.missM > 0.05, `miss reported as ${lifted.missM}`);
  // Still on the sphere: the club length is not negotiable.
  assert.ok(Math.abs(distance(lifted.position, grip) - tooShort) < 1e-6);
});

test("the fit tracks a camera that moves during the clip", () => {
  // Fitted per frame, so a handheld phone costs nothing.
  const positions: Vec3[] = [
    [0.4, 1.5, 5.2],
    [2.5, 1.7, 4.0],
    [4.6, 1.4, 1.2],
  ];
  positions.forEach((position, i) => {
    const truth = perspectiveCamera(position, [0, 1.0, 0.3]);
    const camera = fitCamera(correspondencesFor(10 + i * 50, truth.matrix))!;
    assert.ok(camera.residual < 1e-6, `residual ${camera.residual}`);
    assert.ok(distance(camera.centre, position) < 0.05);
  });
});
