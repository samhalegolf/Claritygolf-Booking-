/**
 * The far arm, checked on its promises.
 *
 * Where the detector saw the arm, nothing changes. Where it did not, the
 * arm comes from the near hand, the grip bubble the clip taught, and the
 * bones the clip measured -- and lands far closer to the truth than a guess
 * through time does. Graded against the fixture, stage off as the control.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { distance, type ClarityJoint, type Vec3 } from "../../contracts";
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
const truth = swing.frames.map((frame) => frame.body.joints);

const FAR_ARM: readonly ClarityJoint[] = ["leftElbow", "leftWrist", "leftHand"];

const observe = (options: SyntheticDetectorOptions = {}): WorldObservationSequence => {
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

const armGone = (startFrame: number, length: number) =>
  observe({ dropouts: FAR_ARM.map((joint) => ({ joint, startFrame, length })) });

const meanError = (
  frames: readonly { body: { joints: Record<ClarityJoint, Vec3> } }[],
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

test("an arm the detector saw is left exactly as seen", () => {
  const report = reconstruct(observe());
  assert.ok(report.arm);
  assert.equal(report.arm.skipped, null);
  assert.deepEqual(report.arm.derived, { elbow: 0, wrist: 0, hand: 0 });
  for (const frame of report.sequence.frames) {
    for (const joint of FAR_ARM) {
      assert.notEqual(frame.provenance.joints[joint].source, "derived");
    }
  }
});

test("an arm unseen at address is built from the near hand, the grip and the bones", () => {
  const gone = armGone(0, 40);
  const off = reconstruct(gone, { stages: { deriveArm: false } }).sequence;
  const on = reconstruct(gone);

  for (const joint of FAR_ARM) {
    const before = meanError(off.frames, joint, 0, 40);
    const after = meanError(on.sequence.frames, joint, 0, 40);
    assert.ok(
      after < 0.1,
      `${joint} should land within 100mm from anatomy alone, got ${(after * 1000).toFixed(0)}mm`
    );
    assert.ok(
      after < before * 0.3,
      `${joint}: derived ${(after * 1000).toFixed(0)}mm against ${(before * 1000).toFixed(0)}mm extrapolated`
    );
  }

  for (let index = 0; index < 40; index += 1) {
    for (const joint of FAR_ARM) {
      assert.equal(on.sequence.frames[index].provenance.joints[joint].source, "derived");
    }
    // Derived, not guessed: both bones hold their measured length.
    const joints = on.sequence.frames[index].body.joints;
    const upper = distance(joints.leftShoulder, joints.leftElbow);
    const fore = distance(joints.leftElbow, joints.leftWrist);
    const trueUpper = distance(truth[index].leftShoulder, truth[index].leftElbow);
    const trueFore = distance(truth[index].leftElbow, truth[index].leftWrist);
    assert.ok(Math.abs(upper - trueUpper) < 0.02, `upper arm ${(upper * 1000).toFixed(0)}mm at frame ${index}`);
    assert.ok(Math.abs(fore - trueFore) < 0.02, `forearm ${(fore * 1000).toFixed(0)}mm at frame ${index}`);
  }
  assert.equal(on.arm?.farSide, "left");
  assert.equal(on.arm?.derived.elbow, 40);
});

test("a bridge across a short gap is kept, not overruled", () => {
  // Mid-swing, a bridge from both sides already knows where the arm went;
  // the bubble only has to agree with it.
  const gone = armGone(60, 20);
  const off = reconstruct(gone, { stages: { deriveArm: false } }).sequence;
  const on = reconstruct(gone).sequence;
  for (const joint of FAR_ARM) {
    const before = meanError(off.frames, joint, 60, 80);
    const after = meanError(on.frames, joint, 60, 80);
    assert.ok(
      after < before + 0.01,
      `${joint}: ${(after * 1000).toFixed(0)}mm with the bubble, ${(before * 1000).toFixed(0)}mm without`
    );
  }
});

test("a weakly seen wrist that wanders off the club is pulled back into the grip bubble", () => {
  const clean = observe();
  const drift: Vec3 = [0.4, 0, 0];
  const sequence: WorldObservationSequence = {
    ...clean,
    frames: clean.frames.map((frame, index) => {
      if (index < 10 || index >= 20) return frame;
      const wrist = frame.joints.leftWrist!;
      return {
        ...frame,
        joints: {
          ...frame.joints,
          // Reported, but at a confidence Clarity does not take as seen.
          leftWrist: {
            ...wrist,
            visibility: 0.3,
            position: [
              wrist.position[0] + drift[0],
              wrist.position[1] + drift[1],
              wrist.position[2] + drift[2],
            ] as Vec3,
          },
        },
      };
    }),
  };

  const report = reconstruct(sequence, { stages: { rejectJumps: false } });
  assert.ok(report.arm && report.arm.gripRadiusM > 0);
  for (let index = 10; index < 20; index += 1) {
    const joints = report.sequence.frames[index].body.joints;
    const apart = distance(joints.leftWrist, joints.rightWrist);
    assert.ok(
      apart <= report.arm.gripRadiusM + 0.03,
      `frame ${index}: wrists ${(apart * 1000).toFixed(0)}mm apart, bubble is ${(report.arm.gripRadiusM * 1000).toFixed(0)}mm`
    );
  }
});

test("the stage can be switched off, and then does nothing", () => {
  const report = reconstruct(armGone(0, 40), { stages: { deriveArm: false } });
  assert.equal(report.arm, null);
  assert.equal(report.stageCounts.armJointsDerived, 0);
});

/*
 * Down the line, the way MediaPipe actually fails: the far elbow is not
 * dropped, it is REPORTED -- weakly, and often out in open picture where
 * nothing hides it. Not being seen is evidence it was not there.
 */
const downTheLine = (elbowShift: Vec3): WorldObservationSequence => {
  const raw = detectFromClarityFrames(swing.frames, { cameraYawDeg: -90 });
  const sequence = anchorSequence({
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (swing.frames.length / swing.fps) * 1000,
    detector: "synthetic",
  });
  return {
    ...sequence,
    frames: sequence.frames.map((frame, index) => {
      if (index >= 40) return frame;
      const joints = { ...frame.joints };
      for (const joint of FAR_ARM) {
        const seen = joints[joint];
        if (!seen) continue;
        const shift: Vec3 = joint === "leftElbow" ? elbowShift : [0, 0, 0];
        joints[joint] = {
          ...seen,
          visibility: 0.3,
          position: [
            seen.position[0] + shift[0],
            seen.position[1] + shift[1],
            seen.position[2] + shift[2],
          ] as Vec3,
        };
      }
      return { ...frame, joints };
    }),
  };
};

test("a weak far elbow read out in open picture is put behind the near one", () => {
  // Across the picture, away from the body: somewhere the camera would
  // have seen it.
  const report = reconstruct(downTheLine([0, 0, -0.25]));
  assert.equal(report.arm?.farSide, "left");
  assert.equal(report.arm?.elbowsBehind, 40);
  const error = meanError(report.sequence.frames, "leftElbow", 0, 40);
  assert.ok(error < 0.1, `elbow ${(error * 1000).toFixed(0)}mm off; the reading was 250mm out`);
  let hidden = 0;
  for (let index = 0; index < 40; index += 1) {
    hidden += report.context?.hiding.leftElbow[index].amount ?? 0;
  }
  assert.ok(hidden / 40 > 0.5, `the elbow should end up hidden, was ${(hidden / 40).toFixed(2)}`);
});

test("a weak far elbow read somewhere hidden is heard, not overruled", () => {
  const report = reconstruct(downTheLine([0, 0, 0]));
  const error = meanError(report.sequence.frames, "leftElbow", 0, 40);
  assert.ok(error < 0.02, `a right reading behind the body should stand: ${(error * 1000).toFixed(0)}mm`);
  assert.ok((report.arm?.elbowsBehind ?? 0) <= 4);
});
