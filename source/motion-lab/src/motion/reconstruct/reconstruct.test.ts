/**
 * Does the Motion Layer actually reconstruct anything?
 *
 * Graded against ground truth, with the naive passthrough as the control.
 * "Better" here means measurably closer to where the body really was -- not
 * smoother, not prettier. A filter can always make motion look nicer by
 * destroying it, so every assertion below is about accuracy or about a
 * physical property, and none is about appearance.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLARITY_JOINTS,
  RIGID_BONES,
  boneKey,
  distance,
  type ClarityJoint,
  type ClaritySequence,
  type Vec3,
} from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import type { CameraObservationSequence } from "../../observe/observation";
import {
  detectFromClarityFrames,
  type SyntheticDetectorOptions,
} from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { passthroughSequence } from "../passthrough";
import { reconstruct, type ReconstructOptions } from "./reconstruct";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);

const observe = (options: SyntheticDetectorOptions = {}) => {
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
  return anchorSequence(camera);
};

/** Mean joint error over a set of frames. The only score that counts. */
const meanError = (
  sequence: ClaritySequence,
  frames: readonly number[],
  joints: readonly ClarityJoint[] = CLARITY_JOINTS
): number => {
  let total = 0;
  let count = 0;
  for (const index of frames) {
    for (const joint of joints) {
      total += distance(sequence.frames[index].body.joints[joint], truth[index][joint]);
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
};

const allFrames = swing.frames.map((frame) => frame.index);
const range = (start: number, length: number) =>
  Array.from({ length }, (_value, offset) => start + offset);

/* ------------------------------------------------------------------ */

test("clean input is not made worse", () => {
  // A reconstruction that improves bad data by degrading good data has not
  // improved anything. With nothing to fix, the layer should be close to a
  // no-op.
  const observations = observe();
  const rebuilt = reconstruct(observations).sequence;

  const error = meanError(rebuilt, allFrames);
  assert.ok(error < 0.006, `clean input drifted by ${(error * 1000).toFixed(1)}mm`);

  for (const frame of rebuilt.frames) {
    assert.equal(frame.provenance.wholeFrameReconstructed, false);
    assert.ok(
      frame.provenance.observedFraction > 0.99,
      `frame ${frame.index} lost observations it should have kept`
    );
  }
  assert.ok(rebuilt.confidence.overall > 0.85);
});

test("a gap across steady motion is reconstructed tightly", () => {
  const dropout = { joint: "rightElbow" as ClarityJoint, startFrame: 30, length: 14 };
  const observations = observe({ dropouts: [dropout] });

  const baseline = passthroughSequence(observations);
  const rebuilt = reconstruct(observations).sequence;

  const gapFrames = range(dropout.startFrame, dropout.length);
  const baselineError = meanError(baseline, gapFrames, ["rightElbow"]);
  const rebuiltError = meanError(rebuilt, gapFrames, ["rightElbow"]);

  assert.ok(
    rebuiltError < baselineError * 0.2,
    `reconstruction ${(rebuiltError * 1000).toFixed(0)}mm vs baseline ${(baselineError * 1000).toFixed(0)}mm`
  );
  assert.ok(
    rebuiltError < 0.03,
    `a 14-frame elbow gap through the takeaway should land within 30mm, got ${(rebuiltError * 1000).toFixed(0)}mm`
  );

  // And it says that it reconstructed them.
  for (const index of gapFrames) {
    assert.equal(rebuilt.frames[index].provenance.joints.rightElbow.source, "reconstructed");
    assert.equal(rebuilt.frames[index].provenance.joints.rightElbow.gapLength, dropout.length);
  }
  assert.equal(rebuilt.confidence.largestGapFrames, dropout.length);
});

test("a gap spanning a direction reversal is much harder, and still beats a hole", () => {
  /*
   * Worth its own test because the difference is large and instructive.
   *
   * Bridging works by taking the least eventful path consistent with the
   * evidence at both ends. When the joint turned round INSIDE the gap, that
   * event is exactly what the endpoints cannot show -- the velocities either
   * side point in opposite directions and the true path went somewhere the
   * evidence never mentions.
   *
   * So the error here is roughly an order of magnitude worse than across
   * steady motion, and no amount of tuning changes that: the information is
   * not there. What the layer can honestly do is beat leaving a hole, and
   * report low confidence. Both are asserted.
   */
  const dropout = { joint: "rightElbow" as ClarityJoint, startFrame: 70, length: 16 };
  const observations = observe({ dropouts: [dropout] });

  const baseline = passthroughSequence(observations);
  const rebuilt = reconstruct(observations).sequence;

  const gapFrames = range(dropout.startFrame, dropout.length);
  const baselineError = meanError(baseline, gapFrames, ["rightElbow"]);
  const rebuiltError = meanError(rebuilt, gapFrames, ["rightElbow"]);

  assert.ok(
    rebuiltError < baselineError * 0.4,
    `reconstruction ${(rebuiltError * 1000).toFixed(0)}mm vs baseline ${(baselineError * 1000).toFixed(0)}mm`
  );

  // And the score says the reconstruction was working hard here.
  const inGap = rebuilt.frames[dropout.startFrame + 8].confidence;
  const clean = rebuilt.frames[10].confidence;
  assert.ok(
    inGap.components.gapReconstruction < clean.components.gapReconstruction * 0.8,
    "a long gap should show in the gap-reconstruction component"
  );
});

test("bridging earns its place: turning it off makes the gap much worse", () => {
  // Each stage should be defensible on its own. If disabling one changes
  // nothing, it is not doing anything.
  const observations = observe({
    dropouts: [{ joint: "leftWrist", startFrame: 60, length: 14 }],
  });
  const gapFrames = range(60, 14);

  const withBridging = reconstruct(observations).sequence;
  const withoutBridging = reconstruct(observations, {
    stages: { bridgeGaps: false },
  } satisfies ReconstructOptions).sequence;

  const on = meanError(withBridging, gapFrames, ["leftWrist"]);
  const off = meanError(withoutBridging, gapFrames, ["leftWrist"]);

  assert.ok(on < off * 0.4, `bridging on ${(on * 1000).toFixed(0)}mm, off ${(off * 1000).toFixed(0)}mm`);
});

test("an isolated bad detection is rejected rather than rendered", () => {
  const observations = observe();
  // Shove one wrist 30cm sideways on a single frame, after anchoring, so the
  // pipeline sees exactly what a bad detection looks like.
  const victim = 95;
  const frame = observations.frames[victim];
  const original = frame.joints.rightWrist!;
  (frame.joints as Record<string, unknown>).rightWrist = {
    ...original,
    position: [original.position[0] + 0.3, original.position[1] - 0.12, original.position[2]],
  };

  const baseline = passthroughSequence(observations);
  const rebuilt = reconstruct(observations).sequence;

  const baselineError = meanError(baseline, [victim], ["rightWrist"]);
  const rebuiltError = meanError(rebuilt, [victim], ["rightWrist"]);

  assert.ok(
    baselineError > 0.25,
    `the baseline should render the bad detection, got ${(baselineError * 1000).toFixed(0)}mm`
  );
  assert.ok(
    rebuiltError < baselineError * 0.35,
    `the jump should be rejected: ${(rebuiltError * 1000).toFixed(0)}mm vs ${(baselineError * 1000).toFixed(0)}mm`
  );

  // And the frames either side are not collateral damage.
  for (const neighbour of [victim - 1, victim + 1]) {
    assert.ok(
      meanError(rebuilt, [neighbour], ["rightWrist"]) < 0.03,
      `frame ${neighbour} was damaged by repairing its neighbour`
    );
  }
});

test("detector noise is reduced, not merely redistributed", () => {
  const noiseM = 0.014;
  const noisy = generateSyntheticSwing({ degradation: { noiseM } });
  const raw = detectFromClarityFrames(noisy.frames);
  const camera: CameraObservationSequence = {
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (swing.frames.length / swing.fps) * 1000,
    detector: "synthetic",
  };
  const observations = anchorSequence(camera);

  const baseline = passthroughSequence(observations);
  const rebuilt = reconstruct(observations).sequence;

  // Graded against the CLEAN body the noise was added to.
  const errorAgainstClean = (sequence: ClaritySequence) => {
    let total = 0;
    let count = 0;
    for (const index of allFrames) {
      for (const joint of CLARITY_JOINTS) {
        total += distance(sequence.frames[index].body.joints[joint], truth[index][joint]);
        count += 1;
      }
    }
    return total / count;
  };

  const baselineError = errorAgainstClean(baseline);
  const rebuiltError = errorAgainstClean(rebuilt);

  assert.ok(
    rebuiltError < baselineError * 0.9,
    `reconstruction ${(rebuiltError * 1000).toFixed(1)}mm should beat raw ${(baselineError * 1000).toFixed(1)}mm`
  );
});

test("reconstructed bones hold their measured length", () => {
  // The constraint the whole physical layer exists to enforce, checked on the
  // output rather than on the input.
  const observations = observe({
    dropouts: [
      { joint: "leftElbow", startFrame: 40, length: 18 },
      { joint: "rightKnee", startFrame: 90, length: 12 },
    ],
  });
  const report = reconstruct(observations);

  for (const bone of RIGID_BONES) {
    const measured = report.bodyModel.bones[boneKey(bone)];
    if (!measured || measured.confidence < 0.35) continue;

    let worst = 0;
    let worstFrame = -1;
    for (const frame of report.sequence.frames) {
      const drift = Math.abs(
        distance(frame.body.joints[bone.from], frame.body.joints[bone.to]) - measured.lengthM
      );
      if (drift > worst) {
        worst = drift;
        worstFrame = frame.index;
      }
    }
    assert.ok(
      worst < measured.lengthM * 0.09,
      `${boneKey(bone)} drifted ${(worst * 1000).toFixed(0)}mm at frame ${worstFrame} ` +
        `(length ${(measured.lengthM * 1000).toFixed(0)}mm)`
    );
  }
});

test("a sustained false detection is rejected, not followed", () => {
  /*
   * The plan's hardest reacquisition case. A joint vanishes, then comes back
   * somewhere the rest of the body says it cannot be -- as if the detector
   * latched onto something in the background. It must not drag the
   * reconstruction with it.
   */
  const observations = observe();
  for (let index = 60; index < 72; index += 1) {
    const joints = observations.frames[index].joints as Record<string, unknown>;
    if (index < 66) {
      delete joints.leftKnee;
      continue;
    }
    const real = truth[index].leftKnee;
    joints.leftKnee = {
      position: [real[0] + 0.45, real[1] + 0.3, real[2]] as Vec3,
      image: [0.5, 0.5],
      visibility: 0.8,
      presence: 0.8,
      sourceCount: 1,
    };
  }

  const baseline = passthroughSequence(observations);
  const rebuilt = reconstruct(observations).sequence;

  const falseFrames = range(66, 6);
  const baselineError = meanError(baseline, falseFrames, ["leftKnee"]);
  const rebuiltError = meanError(rebuilt, falseFrames, ["leftKnee"]);

  assert.ok(
    baselineError > 0.3,
    `the baseline should follow the false detection, got ${(baselineError * 1000).toFixed(0)}mm`
  );
  assert.ok(
    rebuiltError < baselineError * 0.7,
    `the false return should be resisted: ${(rebuiltError * 1000).toFixed(0)}mm vs ${(baselineError * 1000).toFixed(0)}mm`
  );
});

test("a joint that is never seen is reported missing, not placed", () => {
  const observations = observe({
    dropouts: [{ joint: "leftToe", startFrame: 0, length: swing.frames.length }],
  });
  const rebuilt = reconstruct(observations).sequence;

  for (const frame of rebuilt.frames) {
    assert.equal(frame.provenance.joints.leftToe.source, "missing");
    assert.equal(frame.provenance.joints.leftToe.rawConfidence, 0);
  }
  // With a foot point never seen, the support polygon cannot be trusted, so
  // no mass estimate is offered.
  assert.equal(rebuilt.frames[40].mass, null);
});

test("the report says what each stage actually did", () => {
  const observations = observe({
    dropouts: [{ joint: "rightElbow", startFrame: 70, length: 16 }],
  });
  const report = reconstruct(observations);

  assert.ok(report.stageCounts.framesBridged >= 16, "the elbow gap should have been bridged");
  assert.ok(report.bodyModel.sampleCount > 100, "the body model should have plenty of samples");
  assert.ok(report.sequence.source.startsWith("clarity-motion-layer:"));
});

test("confidence falls where the reconstruction worked hardest", () => {
  const observations = observe({
    dropouts: [{ joint: "leftHip", startFrame: 80, length: 20 }],
  });
  const rebuilt = reconstruct(observations).sequence;

  const clean = rebuilt.frames[20].confidence;
  const inGap = rebuilt.frames[90].confidence;

  assert.ok(
    inGap.overall < clean.overall,
    `a reconstructed frame (${inGap.overall.toFixed(2)}) should score below a clean one (${clean.overall.toFixed(2)})`
  );
  assert.ok(inGap.components.directObservation < clean.components.directObservation);
  assert.ok(inGap.components.gapReconstruction < clean.components.gapReconstruction);

  // The damage stays local: the pelvis suffers, the thorax does not.
  assert.ok(inGap.structures.pelvis < clean.structures.pelvis * 0.8);
  assert.ok(inGap.structures.thorax > clean.structures.thorax * 0.9);
});
