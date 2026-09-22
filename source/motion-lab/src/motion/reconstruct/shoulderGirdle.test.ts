/**
 * The shoulder girdle, checked on its promises.
 *
 * Two of them, and they pull in opposite directions, which is the point.
 *
 * It is rigid enough to carry a shoulder the detector never saw -- not to
 * the right distance from the other one, which a bone length already did,
 * but to the right PLACE.
 *
 * And it is not so rigid that it irons out the movement a real girdle has.
 * A scapula that protracts twenty-five millimetres through the clip is
 * measured doing it, allowed to keep doing it, and still reined in when a
 * reading puts a shoulder somewhere this golfer's girdle never went.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  add,
  cross,
  distance,
  lerpVec,
  normalise,
  scale,
  sub,
  type ClarityFrame,
  type ClarityJoint,
  type Vec3,
} from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import type {
  CameraObservationSequence,
  WorldObservationSequence,
} from "../../observe/observation";
import {
  detectFromClarityFrames,
  type SyntheticDetectorOptions,
} from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { reconstruct } from "./reconstruct";

const swing = generateSyntheticSwing();

const observe = (
  frames: readonly ClarityFrame[],
  options: SyntheticDetectorOptions = {}
): WorldObservationSequence => {
  const raw = detectFromClarityFrames(frames, options);
  const camera: CameraObservationSequence = {
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (frames.length / swing.fps) * 1000,
    detector: "synthetic",
  };
  return anchorSequence(camera);
};

const meanError = (
  frames: readonly { body: { joints: Record<ClarityJoint, Vec3> } }[],
  truth: readonly Record<ClarityJoint, Vec3>[],
  joint: ClarityJoint,
  from: number,
  to: number
): number => {
  let total = 0;
  for (let index = from; index < to; index += 1) {
    total += distance(frames[index].body.joints[joint], truth[index][joint]);
  }
  return total / (to - from);
};

/* ------------------------------------------------------------------ *
 * A girdle that really is rigid
 * ------------------------------------------------------------------ */

const rigid = swing.frames;
const rigidTruth = rigid.map((frame) => frame.body.joints);

test("the girdle is measured off the clip, not assumed", () => {
  const report = reconstruct(observe(rigid));
  const template = report.girdle?.template;
  assert.ok(template, report.girdle?.skipped ?? "no template");

  const widths = rigidTruth.map((joints) =>
    distance(joints.leftShoulder, joints.rightShoulder)
  );
  const trueWidth = widths.reduce((total, value) => total + value, 0) / widths.length;
  assert.ok(
    Math.abs(template.widthM - trueWidth) < 0.02,
    `measured ${(template.widthM * 1000).toFixed(0)}mm against ${(trueWidth * 1000).toFixed(0)}mm`
  );

  // A rigid fixture, so every corner should come out rigid and its allowance
  // should be detection noise rather than movement.
  for (const corner of ["leftShoulder", "rightShoulder", "pelvis"] as const) {
    assert.ok(
      template.rigidity[corner] > 0.7,
      `${corner} measured only ${template.rigidity[corner].toFixed(2)} rigid`
    );
    assert.ok(
      template.allowanceM[corner] < 0.02,
      `${corner} allowed ${(template.allowanceM[corner] * 1000).toFixed(0)}mm on a rigid girdle`
    );
  }
});

test("a girdle the detector saw whole is left where it was seen", () => {
  const report = reconstruct(observe(rigid));
  assert.equal(report.girdle?.carried.leftShoulder, 0);
  assert.equal(report.girdle?.carried.rightShoulder, 0);
  for (const joint of ["leftShoulder", "rightShoulder"] as const) {
    assert.ok(
      meanError(report.sequence.frames, rigidTruth, joint, 0, rigid.length) < 0.01,
      `${joint} moved on a clip that saw it perfectly well`
    );
  }
});

test("the neck is the shoulder midpoint on every frame", () => {
  // It is defined as the midpoint -- `observe/` has no other way to make one
  // -- so a reconstruction that reports it anywhere else is contradicting
  // its own vocabulary. It used to, whenever one shoulder went missing and
  // the neck was bridged on its own.
  const gone = observe(rigid, {
    dropouts: [{ joint: "leftShoulder", startFrame: 20, length: 40 }],
  });
  for (const frame of reconstruct(gone).sequence.frames) {
    const { leftShoulder, rightShoulder, neck } = frame.body.joints;
    assert.ok(
      distance(neck, lerpVec(leftShoulder, rightShoulder, 0.5)) < 0.002,
      `neck sits ${(distance(neck, lerpVec(leftShoulder, rightShoulder, 0.5)) * 1000).toFixed(0)}mm off the shoulder line`
    );
  }
});

test("a shoulder lost behind the body is carried there, not guessed through time", () => {
  /*
   * Down the line, as it actually happens: the far shoulder and the whole
   * far arm go at once, from the first frame, so there is nothing on the
   * near side of the gap to bridge from and the stage below has only an
   * extrapolation to work with.
   */
  const hidden: ClarityJoint[] = ["leftShoulder", "leftElbow", "leftWrist", "leftHand"];
  const gone = observe(rigid, {
    dropouts: hidden.map((joint) => ({ joint, startFrame: 0, length: 60 })),
  });

  const off = reconstruct(gone, { stages: { fitGirdle: false } }).sequence;
  const on = reconstruct(gone);

  const before = meanError(off.frames, rigidTruth, "leftShoulder", 0, 60);
  const after = meanError(on.sequence.frames, rigidTruth, "leftShoulder", 0, 60);
  assert.ok(
    after < 0.08,
    `the girdle should place the shoulder within 80mm, got ${(after * 1000).toFixed(0)}mm`
  );
  assert.ok(
    after < before * 0.4,
    `carried ${(after * 1000).toFixed(0)}mm against ${(before * 1000).toFixed(0)}mm extrapolated`
  );
  assert.equal(on.girdle?.carried.leftShoulder, 60);

  // The arm hangs off the girdle, so a shoulder in the right place is worth
  // an elbow in a better one.
  const elbowBefore = meanError(off.frames, rigidTruth, "leftElbow", 0, 60);
  const elbowAfter = meanError(on.sequence.frames, rigidTruth, "leftElbow", 0, 60);
  assert.ok(
    elbowAfter < elbowBefore * 0.5,
    `elbow ${(elbowAfter * 1000).toFixed(0)}mm with the girdle, ${(elbowBefore * 1000).toFixed(0)}mm without`
  );

  for (let index = 0; index < 60; index += 1) {
    assert.equal(on.sequence.frames[index].provenance.joints.leftShoulder.source, "derived");
  }
});

test("a bridge across a shorter gap is kept, not overruled", () => {
  const gone = observe(rigid, {
    dropouts: [{ joint: "leftShoulder", startFrame: 20, length: 40 }],
  });
  const off = reconstruct(gone, { stages: { fitGirdle: false } }).sequence;
  const on = reconstruct(gone).sequence;
  const before = meanError(off.frames, rigidTruth, "leftShoulder", 20, 60);
  const after = meanError(on.frames, rigidTruth, "leftShoulder", 20, 60);
  assert.ok(
    after <= before + 0.002,
    `${(after * 1000).toFixed(0)}mm with the girdle, ${(before * 1000).toFixed(0)}mm without`
  );
});

test("the stage can be switched off, and then does nothing", () => {
  const report = reconstruct(observe(rigid), { stages: { fitGirdle: false } });
  assert.equal(report.girdle, null);
  assert.equal(report.stageCounts.shouldersCarried, 0);
  assert.equal(report.stageCounts.shouldersReined, 0);
});

/* ------------------------------------------------------------------ *
 * A girdle with scapulae on it
 * ------------------------------------------------------------------ */

/** How much the shoulders close on each other over the clip, metres. */
const PROTRACTION_M = 0.06;

/**
 * The same swing with the scapulae working.
 *
 * Both shoulders wrap forward and in toward the midline and back out again
 * over the clip, which is what protraction and retraction do to a pair of
 * acromion landmarks: the girdle narrows and its corners slide forward of
 * the ribcage. It is deliberately the SYMMETRIC movement, because that is
 * the part of scapular travel these landmarks can actually see -- see the
 * module header on what they cannot.
 */
const protracting: ClarityFrame[] = swing.frames.map((frame, index) => {
  const joints = frame.body.joints;
  const across = normalise(sub(joints.rightShoulder, joints.leftShoulder));
  const up = sub(
    lerpVec(joints.leftShoulder, joints.rightShoulder, 0.5),
    lerpVec(joints.leftHip, joints.rightHip, 0.5)
  );
  const foreAft = normalise(cross(across, normalise(up)));
  const phase = Math.sin((index / swing.frames.length) * Math.PI * 2);
  const inward = scale(across, (PROTRACTION_M / 2) * phase);
  const forward = scale(foreAft, (PROTRACTION_M / 2) * phase);
  return {
    ...frame,
    body: {
      ...frame.body,
      joints: {
        ...joints,
        leftShoulder: add(add(joints.leftShoulder, inward), forward),
        rightShoulder: add(sub(joints.rightShoulder, inward), forward),
      },
    },
  };
});
const protractingTruth = protracting.map((frame) => frame.body.joints);

test("a scapula that works is measured working", () => {
  const still = reconstruct(observe(rigid)).girdle?.template;
  const moving = reconstruct(observe(protracting)).girdle?.template;
  assert.ok(still && moving);

  // The allowance is evidence, not a setting: the clip where the girdle
  // flexed has to report more room than the clip where it did not, on both
  // shoulders, because both of them moved.
  for (const shoulder of ["leftShoulder", "rightShoulder"] as const) {
    assert.ok(
      moving.allowanceM[shoulder] > still.allowanceM[shoulder] * 1.4,
      `${shoulder}: flexing girdle allowed ${(moving.allowanceM[shoulder] * 1000).toFixed(0)}mm, still one ${(still.allowanceM[shoulder] * 1000).toFixed(0)}mm`
    );
  }
  // And the pelvis, which did not move, is not handed room it never used.
  assert.ok(
    moving.allowanceM.pelvis < still.allowanceM.pelvis + 0.005,
    `the pelvis was given ${(moving.allowanceM.pelvis * 1000).toFixed(0)}mm it did not ask for`
  );
});

test("scapular movement survives the pipeline instead of being ironed flat", () => {
  const report = reconstruct(observe(protracting));
  for (const shoulder of ["leftShoulder", "rightShoulder"] as const) {
    const error = meanError(
      report.sequence.frames,
      protractingTruth,
      shoulder,
      0,
      protracting.length
    );
    /*
     * A girdle held perfectly rigid would report each shoulder at its median
     * place all clip, so its average error would be the mean of the movement
     * it refused to show -- two thirds of the amplitude. Landing near
     * detection noise instead means the movement came through.
     */
    assert.ok(
      error < 0.01,
      `${shoulder} averaged ${(error * 1000).toFixed(0)}mm out on a clip where it moved ${((PROTRACTION_M / 2) * 1000).toFixed(0)}mm`
    );
  }

  // And the width itself has to still change. A girdle reported at one
  // constant width is a girdle that was ironed flat.
  const widths = report.sequence.frames.map((frame) =>
    distance(frame.body.joints.leftShoulder, frame.body.joints.rightShoulder)
  );
  const swing_ = Math.max(...widths) - Math.min(...widths);
  assert.ok(
    swing_ > PROTRACTION_M * 0.6,
    `width moved only ${(swing_ * 1000).toFixed(0)}mm of the ${(PROTRACTION_M * 1000).toFixed(0)}mm it was given`
  );
});

test("a shoulder beyond anything the clip ever showed is pulled back in", () => {
  const clean = observe(rigid);
  const strayM = 0.25;
  const strayed: WorldObservationSequence = {
    ...clean,
    frames: clean.frames.map((frame, index) => {
      if (index < 30 || index >= 40) return frame;
      const shoulder = frame.joints.leftShoulder;
      if (!shoulder) return frame;
      return {
        ...frame,
        joints: {
          ...frame.joints,
          // Reported, at a confidence Clarity does not take as a sighting.
          leftShoulder: {
            ...shoulder,
            visibility: 0.3,
            position: [
              shoulder.position[0],
              shoulder.position[1] + strayM,
              shoulder.position[2],
            ] as Vec3,
          },
        },
      };
    }),
  };

  const report = reconstruct(strayed, { stages: { rejectJumps: false } });
  const allowance = report.girdle?.template?.allowanceM.leftShoulder;
  assert.ok(allowance !== undefined);
  for (let index = 30; index < 40; index += 1) {
    const error = distance(
      report.sequence.frames[index].body.joints.leftShoulder,
      rigidTruth[index].leftShoulder
    );
    assert.ok(
      error < allowance + 0.03,
      `frame ${index}: shoulder left ${(error * 1000).toFixed(0)}mm out, allowance is ${(allowance * 1000).toFixed(0)}mm`
    );
  }
});
