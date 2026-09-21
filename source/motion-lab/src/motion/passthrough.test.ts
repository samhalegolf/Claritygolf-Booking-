import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type Vec3 } from "../contracts";
import { anchorSequence } from "../observe/anchor";
import type { CameraObservationSequence } from "../observe/observation";
import { detectFromClarityFrames, type SyntheticDetectorOptions } from "../observe/syntheticDetector";
import { toCameraFrame } from "../observe/toCameraFrame";
import { generateSyntheticSwing } from "../synthetic/syntheticSwing";
import { passthroughSequence } from "./passthrough";

const swing = generateSyntheticSwing();

const pipeline = (options: SyntheticDetectorOptions = {}) => {
  const raw = detectFromClarityFrames(swing.frames, options);
  const camera: CameraObservationSequence = {
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (swing.frames.length / swing.fps) * 1000,
    detector: "synthetic",
  };
  return passthroughSequence(anchorSequence(camera));
};

test("the whole pipeline produces a usable ClaritySequence", () => {
  const result = pipeline();
  assert.equal(result.frames.length, swing.frames.length);
  assert.equal(result.fps, swing.fps);
  assert.ok(result.source.startsWith("passthrough:"));

  for (const frame of result.frames) {
    for (const joint of CLARITY_JOINTS) {
      const position = frame.body.joints[joint];
      assert.ok(
        Number.isFinite(position[0] + position[1] + position[2]),
        `frame ${frame.index} joint ${joint} is not finite`
      );
    }
  }
});

test("bone lengths are measured from the clip and match the real body", () => {
  const result = pipeline();
  const trueFemur = distance(
    swing.frames[0].body.joints.leftHip,
    swing.frames[0].body.joints.leftKnee
  );
  const measured = result.bodyModel.boneLengths["leftHip~leftKnee"];
  assert.ok(
    Math.abs(measured - trueFemur) < 0.02,
    `measured femur ${measured.toFixed(3)}m against a true ${trueFemur.toFixed(3)}m`
  );
  assert.ok(
    Math.abs(result.bodyModel.estimatedHeightM - 1.8) < 0.15,
    `estimated height ${result.bodyModel.estimatedHeightM.toFixed(2)}m, expected about 1.8m`
  );
});

test("a median bone length shrugs off a single wild detection", () => {
  // One frame placing a wrist on the background must not stretch the forearm
  // for the whole clip. The median simply ignores it; a mean would not.
  const clean = pipeline().bodyModel.boneLengths["leftElbow~leftWrist"];

  const frames = swing.frames.map((frame, index) =>
    index !== 40
      ? frame
      : {
          ...frame,
          body: {
            ...frame.body,
            joints: { ...frame.body.joints, leftWrist: [3, 3, 3] as Vec3 },
          },
        }
  );
  const raw = detectFromClarityFrames(frames);
  const camera: CameraObservationSequence = {
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (swing.frames.length / swing.fps) * 1000,
    detector: "synthetic",
  };
  const polluted = passthroughSequence(anchorSequence(camera)).bodyModel.boneLengths[
    "leftElbow~leftWrist"
  ];

  assert.ok(
    Math.abs(polluted - clean) < 0.005,
    `one bad frame moved the measured forearm from ${clean.toFixed(4)} to ${polluted.toFixed(4)}`
  );
});

test("a joint the detector never saw is marked missing, not invented", () => {
  const result = pipeline({
    dropouts: [{ joint: "rightKnee", startFrame: 30, length: 12 }],
  });

  const during = result.frames[35];
  assert.equal(during.provenance.joints.rightKnee.source, "missing");
  assert.equal(during.provenance.joints.rightKnee.rawConfidence, 0);
  assert.ok(during.provenance.observedFraction < 1);

  // The baseline reconstructs nothing, so it must not claim to have bridged
  // anything either.
  assert.equal(result.confidence.largestGapFrames, 0);
  assert.equal(during.confidence.components.jumpCorrection, 1);

  const before = result.frames[29];
  assert.equal(before.provenance.joints.rightKnee.source, "observed");
});

test("positions survive the full round trip", () => {
  const result = pipeline({ cameraYawDeg: 25 });
  let worst = 0;
  for (const frame of result.frames) {
    const truth = swing.frames[frame.index].body.joints;
    for (const joint of CLARITY_JOINTS) {
      if (frame.provenance.joints[joint].source !== "observed") continue;
      worst = Math.max(worst, distance(frame.body.joints[joint], truth[joint]));
    }
  }
  assert.ok(worst < 0.01, `worst error through the whole pipeline was ${(worst * 1000).toFixed(1)}mm`);
});

test("thorax and pelvis are oriented, and separation survives the pipeline", () => {
  const result = pipeline();
  const top = result.frames[Math.round(1.22 * swing.fps)];

  assert.ok(top.body.thorax.support > 0.5, "the thorax should be well supported here");
  assert.ok(top.body.pelvis.support > 0.5);

  // The structures must disagree at the top, which is the whole reason they
  // are separate bodies rather than one torso.
  const truth = swing.frames[top.index].body;
  const thoraxError = Math.abs(
    top.body.thorax.orientation[1] - truth.thorax.orientation[1]
  );
  assert.ok(thoraxError < 0.12, `thorax orientation drifted by ${thoraxError.toFixed(3)}`);
});

test("mass is withheld when too little of the body was seen", () => {
  // Better no mass estimate than one distributed over a body that is mostly
  // absent.
  const result = pipeline({
    dropouts: CLARITY_JOINTS.slice(0, 12).map((joint) => ({
      joint,
      startFrame: 20,
      length: 8,
    })),
  });
  assert.equal(result.frames[24].mass, null);
  assert.ok(result.frames[5].mass, "a well-seen frame still gets a mass estimate");
});

test("the baseline makes no club claim", () => {
  const result = pipeline();
  for (const frame of result.frames) {
    assert.equal(frame.club, null, "a CBP invented from the hands would be an unsupported claim");
    assert.equal(frame.confidence.components.clubPoint, 0);
  }
});
