/**
 * The observation pipeline, end to end.
 *
 * A known body -> the detector's convention -> the real mapping and anchoring
 * -> back to Clarity world space. If what comes out is not what went in, one
 * of the axis conversions is wrong.
 *
 * This matters more than it looks. A mirrored reconstruction does not throw
 * and does not look broken -- it looks like a left-handed golfer. Without a
 * round trip against known truth, that survives to production.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type ClarityJoint, type Vec3 } from "../contracts";
import { generateSyntheticSwing } from "../synthetic/syntheticSwing";
import { anchorSequence, detectionRate, findAnchorFrame } from "./anchor";
import type { CameraObservationSequence, ObservationFrame, RawLandmark } from "./observation";
import { detectFromClarityFrames } from "./syntheticDetector";
import { observedFraction, toCameraFrame, toClarityAxes } from "./toCameraFrame";

const swing = generateSyntheticSwing();

const buildCameraSequence = (
  raw: readonly ObservationFrame[]
): CameraObservationSequence => ({
  space: "camera",
  frames: raw.map((frame) => toCameraFrame(frame)),
  fps: swing.fps,
  width: 1920,
  height: 1080,
  durationMs: swing.frames.length * (1000 / swing.fps),
  detector: "synthetic",
});

const runPipeline = (options: Parameters<typeof detectFromClarityFrames>[1] = {}) =>
  anchorSequence(buildCameraSequence(detectFromClarityFrames(swing.frames, options)));

/* ------------------------- the axis conversion ------------------------- */

test("toClarityAxes flips Y and Z, and keeps the frame right-handed", () => {
  const point: RawLandmark = { x: 0.3, y: 0.7, z: 0.2, visibility: 1, presence: 1 };
  assert.deepEqual(toClarityAxes(point), [0.3, -0.7, -0.2]);

  // Handedness is the thing that matters. MediaPipe's basis is (right, down,
  // into-screen), which is right-handed; ours must be too. Negating Y alone
  // would mirror the golfer -- and a mirrored swing still looks like a swing.
  const right = toClarityAxes({ x: 1, y: 0, z: 0, visibility: 1, presence: 1 });
  const down = toClarityAxes({ x: 0, y: 1, z: 0, visibility: 1, presence: 1 });
  const into = toClarityAxes({ x: 0, y: 0, z: 1, visibility: 1, presence: 1 });

  // right x up should be toward the camera, which is where -into landed.
  const up: Vec3 = [-down[0], -down[1], -down[2]];
  const cross: Vec3 = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];
  const towardCamera: Vec3 = [-into[0], -into[1], -into[2]];
  assert.ok(
    distance(cross, towardCamera) < 1e-9,
    `right x up should point toward the camera: got ${cross}, wanted ${towardCamera}`
  );
});

/* ---------------------------- the mapping ------------------------------ */

test("a joint is dropped when any landmark it is built from is missing", () => {
  // A midpoint built from one good landmark and one missing one is not a
  // midpoint; it sits half a head-width from the truth and reports itself as
  // observed. Better to have no head than a confidently wrong one.
  const [raw] = detectFromClarityFrames([swing.frames[0]]);
  const world = [...(raw.world ?? [])];
  world[7] = { x: 0, y: 0, z: 0, visibility: 0, presence: 0 }; // left ear

  const frame = toCameraFrame({ ...raw, world });
  assert.equal(frame.joints.head, undefined, "head should be absent, not approximated");
  assert.ok(frame.joints.neck, "the neck is built from other landmarks and survives");
});

test("an undetected frame yields no joints at all", () => {
  const [raw] = detectFromClarityFrames([swing.frames[0]], { blindFrames: [0] });
  const frame = toCameraFrame(raw);
  assert.equal(frame.detected, false);
  assert.equal(Object.keys(frame.joints).length, 0);
  assert.equal(observedFraction(frame), 0);
});

test("low visibility is dropped, not silently trusted", () => {
  const [raw] = detectFromClarityFrames([swing.frames[0]]);
  const world = (raw.world ?? []).map((entry) => ({ ...entry, visibility: 0.05 }));
  const frame = toCameraFrame({ ...raw, world });
  assert.equal(Object.keys(frame.joints).length, 0);

  // The floor is configurable, and a permissive floor keeps the evidence.
  const permissive = toCameraFrame({ ...raw, world }, { visibilityFloor: 0, presenceFloor: 0 });
  assert.ok(Object.keys(permissive.joints).length > 15);
});

test("derived joints record how many landmarks they came from", () => {
  const [raw] = detectFromClarityFrames([swing.frames[0]]);
  const frame = toCameraFrame(raw);
  assert.equal(frame.joints.leftShoulder?.sourceCount, 1);
  assert.equal(frame.joints.head?.sourceCount, 2, "the head is the midpoint of the ears");
  assert.equal(frame.joints.neck?.sourceCount, 2);
  assert.equal(frame.joints.leftHand?.sourceCount, 2);
});

/* --------------------------- the round trip ---------------------------- */

test("a body survives the round trip through the detector's convention", () => {
  const anchored = runPipeline();

  let worst = 0;
  let worstJoint: ClarityJoint | null = null;
  let worstFrame = -1;

  for (const frame of anchored.frames) {
    const truth = swing.frames[frame.index].body.joints;
    for (const joint of CLARITY_JOINTS) {
      const observed = frame.joints[joint];
      if (!observed) continue;
      const error = distance(observed.position as Vec3, truth[joint]);
      if (error > worst) {
        worst = error;
        worstJoint = joint;
        worstFrame = frame.index;
      }
    }
  }

  assert.ok(
    worst < 0.01,
    `worst round-trip error was ${(worst * 1000).toFixed(1)}mm at ${worstJoint} on frame ${worstFrame}`
  );
});

test("the round trip survives the golfer standing at an angle to the camera", () => {
  // With no camera yaw the anchoring rotation is the identity, so a broken
  // rotation would pass unnoticed. Standing the golfer at 37 degrees makes
  // the rotation do real work.
  const anchored = runPipeline({ cameraYawDeg: 37 });

  let worst = 0;
  for (const frame of anchored.frames) {
    const truth = swing.frames[frame.index].body.joints;
    for (const joint of CLARITY_JOINTS) {
      const observed = frame.joints[joint];
      if (!observed) continue;
      worst = Math.max(worst, distance(observed.position as Vec3, truth[joint]));
    }
  }
  assert.ok(worst < 0.01, `yawed round-trip error was ${(worst * 1000).toFixed(1)}mm`);
});

test("the golfer is not mirrored: anatomical left stays on the -X side at address", () => {
  const anchored = runPipeline({ cameraYawDeg: 37 });
  const address = anchored.frames[0];

  const left = address.joints.leftAnkle!;
  const right = address.joints.rightAnkle!;
  assert.ok(
    left.position[0] < right.position[0],
    `+X must run from the left foot toward the right foot, got L=${left.position[0].toFixed(3)} R=${right.position[0].toFixed(3)}`
  );

  // And the body is the right way up.
  assert.ok(address.joints.head!.position[1] > address.joints.leftHip!.position[1]);
  assert.ok(address.joints.leftHip!.position[1] > address.joints.leftAnkle!.position[1]);
});

/* ---------------------------- the anchor ------------------------------- */

test("the anchor lands on the still address hold, not mid-swing", () => {
  const camera = buildCameraSequence(detectFromClarityFrames(swing.frames));
  const choice = findAnchorFrame(camera.frames);

  // Address is held for the first 0.4s, so the anchor should be inside it.
  assert.ok(
    choice.index <= Math.round(0.4 * swing.fps),
    `anchor landed at frame ${choice.index}, outside the address hold`
  );
  assert.equal(choice.stable, true);
});

test("the anchor measures stance width, and it matches the body", () => {
  const anchored = runPipeline();
  const trueWidth = distance(
    swing.frames[0].body.joints.leftAnkle,
    swing.frames[0].body.joints.rightAnkle
  );
  assert.ok(
    Math.abs(anchored.anchor.stanceWidthM - trueWidth) < 0.01,
    `measured ${anchored.anchor.stanceWidthM.toFixed(3)}m against a true ${trueWidth.toFixed(3)}m`
  );
  assert.equal(anchored.anchor.anchorIsStable, true);
});

test("the feet stay on the ground through the whole swing", () => {
  // Anchoring pins the ground. If a foot floats or sinks, the support model
  // downstream is computing contact against nothing.
  const anchored = runPipeline();
  for (const frame of anchored.frames) {
    const candidates = (["leftHeel", "leftToe", "rightHeel", "rightToe"] as const)
      .map((joint) => frame.joints[joint]?.position[1])
      .filter((value): value is number => value !== undefined);
    if (candidates.length === 0) continue;

    const lowest = Math.min(...candidates);
    assert.ok(
      Math.abs(lowest) < 1e-6,
      `frame ${frame.index}: lowest foot point is at Y=${lowest.toFixed(4)}, not on the ground`
    );
  }
});

test("a frame with no visible feet carries the previous offset instead of snapping", () => {
  // Losing the feet for a moment must not jolt the whole body. A one-frame
  // jump of the entire skeleton reads as a tracking failure, and would be one
  // the pipeline caused.
  const anchored = runPipeline({
    dropouts: [
      { joint: "leftAnkle", startFrame: 60, length: 6 },
      { joint: "rightAnkle", startFrame: 60, length: 6 },
      { joint: "leftHeel", startFrame: 60, length: 6 },
      { joint: "rightHeel", startFrame: 60, length: 6 },
      { joint: "leftToe", startFrame: 60, length: 6 },
      { joint: "rightToe", startFrame: 60, length: 6 },
    ],
  });

  const before = anchored.frames[59].joints.neck!;
  const during = anchored.frames[60].joints.neck!;
  assert.ok(
    distance(before.position as Vec3, during.position as Vec3) < 0.08,
    "the body jumped when the feet were lost"
  );
});

test("an anchor found without both feet is reported as unstable", () => {
  // The axes cannot be trusted, and the sequence has to say so rather than
  // quietly producing confident nonsense.
  const raw = detectFromClarityFrames(swing.frames, {
    dropouts: [{ joint: "rightAnkle", startFrame: 0, length: swing.frames.length }],
  });
  const anchored = anchorSequence(buildCameraSequence(raw));
  assert.equal(anchored.anchor.anchorIsStable, false);
  assert.equal(anchored.anchor.stanceWidthM, 0);
});

test("detection rate reflects blind frames", () => {
  const camera = buildCameraSequence(
    detectFromClarityFrames(swing.frames, { blindFrames: [10, 11, 12, 13] })
  );
  const expected = (swing.frames.length - 4) / swing.frames.length;
  assert.ok(Math.abs(detectionRate(camera) - expected) < 1e-9);
});

test("a dropout leaves the joint absent rather than filled in", () => {
  const anchored = runPipeline({
    dropouts: [{ joint: "leftElbow", startFrame: 40, length: 10 }],
  });
  assert.equal(anchored.frames[45].joints.leftElbow, undefined);
  assert.ok(anchored.frames[39].joints.leftElbow, "present before the gap");
  assert.ok(anchored.frames[50].joints.leftElbow, "present after the gap");
});
