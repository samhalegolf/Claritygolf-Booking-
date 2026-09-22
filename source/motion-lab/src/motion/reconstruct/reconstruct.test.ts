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
  JOINTS_BY_STRUCTURE,
  OBSERVABLE_JOINTS,
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
    // Over the joints a detector reports. The sternum is built by the girdle
    // on every frame of every clip, so "was it left as seen?" is not a
    // question about it.
    for (const joint of OBSERVABLE_JOINTS) {
      const source = frame.provenance.joints[joint].source;
      // The feet are the leash's: held at their anchor, or moved onto the arc
      // a lifting heel takes. Everything else must be left exactly as seen.
      const allowed: readonly string[] = JOINTS_BY_STRUCTURE.feet.includes(joint)
        ? ["observed", "anchored", "constrained"]
        : ["observed"];
      assert.ok(
        allowed.includes(source),
        `frame ${frame.index} ${joint} is ${source}, should have been kept as observed`
      );
    }
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

  // And it says that it reconstructed them -- or, where the bridge strayed
  // off the arm's own bone lengths and the arm stage pulled it back on,
  // that anatomy had the final say.
  for (const index of gapFrames) {
    const source = rebuilt.frames[index].provenance.joints.rightElbow.source;
    assert.ok(
      source === "reconstructed" || source === "derived",
      `frame ${index} elbow is ${source}`
    );
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

/* ------------------------- the club, end to end ---------------------- */

test("the pipeline recovers a club from image detections alone", () => {
  /*
   * The whole Build 4 claim, end to end. The detector reports the clubhead as
   * two normalised image coordinates and nothing else -- no depth, no length,
   * no calibration -- and a CBP in metres comes out the other side.
   *
   * Everything in between is derived: the camera from the body's own joints,
   * the club's length from how far the viewing rays pass from the hands, and
   * the depth from what a wrist can and cannot do.
   *
   * Filmed from 75 degrees round -- near a down-the-line view -- which is
   * where the wrist cue is strong. See the club model's own tests for the
   * face-on case, where it is not.
   */
  const observations = observe({ cameraYawDeg: 75 });
  const rebuilt = reconstruct(observations).sequence;

  const withClub = rebuilt.frames.filter((frame) => frame.club !== null);
  assert.ok(
    withClub.length > rebuilt.frames.length * 0.9,
    `only ${withClub.length} of ${rebuilt.frames.length} frames got a club`
  );

  const errors = rebuilt.frames
    .filter((frame) => frame.club)
    .map((frame) => distance(frame.club!.cbp, swing.frames[frame.index].club!.cbp))
    .sort((a, b) => a - b);
  const median = errors[Math.floor(errors.length / 2)];

  assert.ok(
    median < 0.03,
    `median CBP error ${(median * 1000).toFixed(0)}mm`
  );
  assert.ok(
    errors[errors.length - 1] < 0.08,
    `worst CBP error ${(errors[errors.length - 1] * 1000).toFixed(0)}mm`
  );

  // The club's length was measured, not assumed, and it is one club.
  const lengths = withClub.map((frame) => frame.club!.lengthM);
  assert.ok(
    Math.max(...lengths) - Math.min(...lengths) < 1e-9,
    "a rigid club should report one length for the whole swing"
  );
  const trueSpan = distance(
    [
      (swing.frames[0].body.joints.leftHand[0] + swing.frames[0].body.joints.rightHand[0]) / 2,
      (swing.frames[0].body.joints.leftHand[1] + swing.frames[0].body.joints.rightHand[1]) / 2,
      (swing.frames[0].body.joints.leftHand[2] + swing.frames[0].body.joints.rightHand[2]) / 2,
    ],
    swing.frames[0].club!.head
  );
  assert.ok(
    Math.abs(lengths[0] - trueSpan) < 0.03,
    `measured club ${lengths[0].toFixed(3)}m against a true span of ${trueSpan.toFixed(3)}m`
  );
});

test("a poor club track does not drag down the body score", () => {
  // The plan's rule, now that there is a real club to test it with.
  const observations = observe({ cameraYawDeg: 75, clubLostFrom: 70 });
  const rebuilt = reconstruct(observations).sequence;

  const before = rebuilt.frames[60];
  const after = rebuilt.frames[110];

  assert.ok(before.club, "the club should be tracked before it is lost");
  assert.ok(
    (after.club?.confidence ?? 0) < (before.club?.confidence ?? 1) * 0.5,
    "club confidence should have fallen once the head was lost"
  );

  // The body is unaffected.
  assert.ok(
    after.confidence.overall > before.confidence.overall * 0.95,
    `the body score fell from ${before.confidence.overall.toFixed(2)} to ${after.confidence.overall.toFixed(2)} because the club was lost`
  );
  assert.ok(after.confidence.structures.thorax > 0.8);
});

test("no club evidence at all leaves the club null, not guessed", () => {
  const observations = observe({ cameraYawDeg: 75, clubLostFrom: 0 });
  const rebuilt = reconstruct(observations).sequence;
  assert.ok(rebuilt.frames.every((frame) => frame.club === null));
  assert.equal(rebuilt.frames[60].confidence.components.clubPoint, 0);
  // And the body is still fine.
  assert.ok(rebuilt.frames[60].confidence.overall > 0.85);
});

test("a landmark that slides onto the wrong part of the body and stays there is rejected", () => {
  /*
   * The failure this was written for: a left shoulder walking onto the middle
   * of the back, at full detector confidence, and staying there.
   *
   * It is deliberately NOT a spike. The two guards that existed before this
   * both need one -- reacquisition validation only judges a joint that went
   * MISSING and came back, and the second difference of a constant error is
   * zero, so only the two frames at the seam deviate at all. Everything in
   * between used to sail through fully trusted.
   *
   * The slip is expressed in the BODY's frame, not the world's, because that
   * is what the detector actually does: the landmark sits at an anatomical
   * place it does not belong to and travels with the golfer. A fixed world
   * offset would rotate relative to the shoulder line through the swing, and
   * a fixed offset that happens to lie along a bone is a different and much
   * harder problem -- see the header of contradiction.ts.
   *
   * The neck is dragged half as far, because that is what really happens: it
   * is built as the midpoint of the two shoulder landmarks, so a shoulder
   * displaced by e moves it by e/2.
   */
  const plateau = range(40, 12);
  const towardSpine = 0.45; // fraction of the way across to the other shoulder
  const observations = observe();

  for (const index of plateau) {
    const joints = observations.frames[index].joints as Record<string, { position: Vec3 }>;
    const left = joints.leftShoulder.position;
    const right = joints.rightShoulder.position;
    const slip: Vec3 = [
      (right[0] - left[0]) * towardSpine,
      (right[1] - left[1]) * towardSpine,
      (right[2] - left[2]) * towardSpine,
    ];
    for (const [joint, share] of [["leftShoulder", 1], ["neck", 0.5]] as const) {
      const observed = joints[joint];
      joints[joint] = {
        ...observed,
        position: [
          observed.position[0] + slip[0] * share,
          observed.position[1] + slip[1] * share,
          observed.position[2] + slip[2] * share,
        ],
      };
    }
  }

  const baseline = passthroughSequence(observations);
  const rebuilt = reconstruct(observations).sequence;
  // The same data with only this stage switched off, to show it is the one
  // paying for the difference rather than the guards that were already here.
  const withoutStage = reconstruct(observations, {
    stages: { rejectContradictions: false },
  }).sequence;

  const baselineError = meanError(baseline, plateau, ["leftShoulder"]);
  const rebuiltError = meanError(rebuilt, plateau, ["leftShoulder"]);
  const unguardedError = meanError(withoutStage, plateau, ["leftShoulder"]);

  assert.ok(
    baselineError > 0.15,
    `the baseline should render the slip, got ${(baselineError * 1000).toFixed(0)}mm`
  );
  /*
   * Without this stage the other guards do NOT leave the slip untouched. The
   * constraint solver hauls the shoulder part of the way back to satisfy the
   * bones it is breaking, and the shoulder girdle reins the reading toward
   * the shape the rest of the clip measured; between them 187mm of slip comes
   * down to about 16mm. Neither of them is free of it, though. The solver
   * gets there by splitting every correction with the joint at the other end,
   * so it drags good observations along with it, and the girdle can only pull
   * a reading back to the edge of what this golfer's girdle was seen to do --
   * which is still a shoulder three times the detector's own noise off the
   * body. Rejecting the reading beats negotiating with it, and the full
   * pipeline lands at 5mm.
   */
  assert.ok(
    unguardedError > 0.012,
    "without this stage the shoulder should still be badly placed, got " +
      `${(unguardedError * 1000).toFixed(0)}mm`
  );
  assert.ok(
    rebuiltError < unguardedError * 0.6,
    "the slipped shoulder should be rejected and bridged: " +
      `${(rebuiltError * 1000).toFixed(0)}mm vs ${(unguardedError * 1000).toFixed(0)}mm with the stage off`
  );
  assert.ok(
    meanError(rebuilt, plateau) < meanError(withoutStage, plateau),
    "the whole body should be closer to the truth, not just the one joint"
  );

  // The observations were refused, not merely smoothed.
  const refused = plateau.filter(
    (index) => rebuilt.frames[index].provenance.joints.leftShoulder.source !== "observed"
  );
  assert.ok(
    refused.length >= plateau.length - 1,
    `only ${refused.length} of ${plateau.length} plateau frames stopped being "observed"`
  );

  /*
   * And the innocent joints on the other ends of those broken bones keep
   * their readings, rather than being deleted for the crime of being attached
   * to a bad one. "Kept" is broader than "observed" on purpose: the solver
   * may still have MOVED one of them, which is a different complaint and the
   * business of the trust cap below, not of the rejection stage.
   *
   * The two bystanders are deliberately not held to the same standard,
   * because the body's evidence about them is not the same.
   *
   *   leftElbow      is bonded to the slipped shoulder and to the wrist, and
   *                  the wrist end is intact and well supported. The body can
   *                  tell which of the two is wrong, so the elbow should come
   *                  through almost untouched.
   *
   *   rightShoulder  cannot be resolved that cleanly, and the reason is worth
   *                  recording. `neck` is BUILT as the midpoint of the two
   *                  shoulder landmarks, so the slip drags it half way too --
   *                  and the neck and the right shoulder then sit in exactly
   *                  symmetric positions: one broken bone (to each other) and
   *                  one intact one (to the head, to the right elbow). The
   *                  bones genuinely cannot say which of the pair moved, so
   *                  the solver splits the difference and the right shoulder
   *                  takes some of it. That is a limit of deriving the neck
   *                  from the joints it is meant to corroborate, not of the
   *                  guards here, and no threshold fixes it.
   */
  const kept: readonly string[] = ["observed", "constrained", "anchored"];
  const expected = [
    { bystander: "leftElbow", withStage: 0.012, withoutStage: 0.03 },
    { bystander: "rightShoulder", withStage: 0.03, withoutStage: 0.06 },
  ] as const;

  for (const { bystander, withStage, withoutStage: withoutStageM } of expected) {
    const survived = plateau.filter((index) =>
      kept.includes(rebuilt.frames[index].provenance.joints[bystander].source)
    );
    assert.equal(
      survived.length,
      plateau.length,
      `${bystander}'s observations were thrown away too: only ${survived.length} of ${plateau.length} kept`
    );

    const on = meanError(rebuilt, plateau, [bystander]);
    const off = meanError(withoutStage, plateau, [bystander]);
    assert.ok(on < off, `${bystander} is no better off for the slip having been rejected`);

    /*
     * The trust cap, on its own terms.
     *
     * `withoutStage` is the harder case for it: the slipped shoulder is never
     * rejected, so it reaches the solver still claiming to be an observation.
     * With trust taken from the detector, the solver split the broken bones
     * with it fifty-fifty and hauled these two out to 45mm and 65mm -- one bad
     * landmark becoming three bad joints. Capping trust by what the body
     * agrees with makes the contradicted joint yield instead, whether or not
     * anything upstream caught the slip.
     */
    assert.ok(
      off < withoutStageM,
      `${bystander} was dragged by the joint it is attached to: ${(off * 1000).toFixed(0)}mm`
    );
    assert.ok(
      on < withStage,
      `${bystander} should be little touched with both guards in: ${(on * 1000).toFixed(0)}mm`
    );
  }
});
