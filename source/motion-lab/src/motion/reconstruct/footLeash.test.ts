/**
 * The foot leash, checked on its promises.
 *
 * A foot stays where it was until the knee proves it moved; when it moves,
 * it moves the way a foot can; and a detector's wandering reading of a
 * planted foot is set aside rather than blended in. Graded against the
 * fixture's ground truth, with the leash switched off as the control.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { distance, type ClarityJoint, type Vec3 } from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import type {
  CameraObservationSequence,
  WorldObservationSequence,
} from "../../observe/observation";
import { detectFromClarityFrames } from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { reconstruct } from "./reconstruct";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);

const FEET: readonly ClarityJoint[] = [
  "leftAnkle",
  "leftHeel",
  "leftToe",
  "rightAnkle",
  "rightHeel",
  "rightToe",
];

const observe = (): WorldObservationSequence => {
  const raw = detectFromClarityFrames(swing.frames, {});
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

/** A deterministic wobble, so the test is the same every run. */
const wobble = (seed: number): number => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

/**
 * The failure this stage exists for: down the line the feet's depth is a
 * guess, so the detector's foot markers wander along the stance line while
 * the golfer stands perfectly still. Modelled as a wobble on the anchored
 * world's X axis, which is the stance line.
 */
const withWanderingFeet = (
  sequence: WorldObservationSequence,
  amplitudeM: number,
  joints: readonly ClarityJoint[] = FEET
): WorldObservationSequence => ({
  ...sequence,
  frames: sequence.frames.map((frame, index) => {
    const perturbed = { ...frame.joints };
    joints.forEach((joint, slot) => {
      const observed = perturbed[joint];
      if (!observed) return;
      const shift = wobble(index * 7 + slot) * amplitudeM;
      perturbed[joint] = {
        ...observed,
        position: [
          observed.position[0] + shift,
          observed.position[1],
          observed.position[2],
        ] as Vec3,
      };
    });
    return { ...frame, joints: perturbed };
  }),
});

const meanError = (
  frames: readonly { body: { joints: Record<ClarityJoint, Vec3> }; index: number }[],
  joints: readonly ClarityJoint[],
  indices: readonly number[]
): number => {
  let total = 0;
  let count = 0;
  for (const index of indices) {
    for (const joint of joints) {
      total += distance(frames[index].body.joints[joint], truth[index][joint]);
      count += 1;
    }
  }
  return total / count;
};

const range = (start: number, end: number) =>
  Array.from({ length: end - start }, (_value, offset) => start + offset);

/** Frames where the fixture has both feet flat on the ground. */
const ADDRESS_FRAMES = range(0, 24);

test("a wandering foot marker is held, not followed", () => {
  const wandering = withWanderingFeet(observe(), 0.03);

  const off = reconstruct(wandering, { stages: { leashFeet: false } }).sequence;
  const on = reconstruct(wandering).sequence;

  const offError = meanError(off.frames, FEET, ADDRESS_FRAMES);
  const onError = meanError(on.frames, FEET, ADDRESS_FRAMES);
  // What the same frames score with nothing wrong at all. The world anchor
  // leaves a few millimetres of common-mode offset on every joint, so this
  // is the floor, not zero.
  const cleanError = meanError(
    reconstruct(observe(), { stages: { leashFeet: false } }).sequence.frames,
    FEET,
    ADDRESS_FRAMES
  );

  assert.ok(
    onError < offError * 0.7,
    `the leash should take most of the wander out: ${(onError * 1000).toFixed(1)}mm ` +
      `against ${(offError * 1000).toFixed(1)}mm without it`
  );
  assert.ok(
    onError < cleanError + 0.005,
    `held feet should score close to clean ones: ${(onError * 1000).toFixed(1)}mm ` +
      `against ${(cleanError * 1000).toFixed(1)}mm clean`
  );
  // And the knee, tied to the anchored ankle, benefits rather than suffers.
  const knees: readonly ClarityJoint[] = ["leftKnee", "rightKnee"];
  assert.ok(
    meanError(on.frames, knees, ADDRESS_FRAMES) <= meanError(off.frames, knees, ADDRESS_FRAMES) + 0.002,
    "anchoring the feet should not push the knees off"
  );
});

test("a planted foot is reported as anchored, with the detector's reading set aside", () => {
  const report = reconstruct(withWanderingFeet(observe(), 0.03));

  for (const index of ADDRESS_FRAMES) {
    const frame = report.sequence.frames[index];
    for (const joint of FEET) {
      const provenance = frame.provenance.joints[joint];
      assert.equal(provenance.source, "anchored", `${joint} at frame ${index}`);
      // Anchored feet still count as seen: the detector saw them, the anchor
      // only decided where they were.
      assert.equal(provenance.framesSinceObserved, 0);
    }
    assert.ok(frame.provenance.observedFraction > 0.99, `frame ${index} lost its observations`);
    assert.equal(report.feet?.states.left[index].phase, "planted");
    assert.equal(report.feet?.states.right[index].phase, "planted");
  }
  assert.ok(report.stageCounts.feetAnchored > ADDRESS_FRAMES.length * 2);
});

test("a heel comes up when the knee pulls the tibia taut, and goes back down when it slackens", () => {
  const report = reconstruct(observe());
  const left = report.feet!.states.left;

  // The fixture lifts the lead heel through the backswing and plants it
  // again for the downswing. The leash should see both.
  const lifted = left.map((state, index) => (state.phase === "heel-up" ? index : -1)).filter((i) => i >= 0);
  assert.ok(lifted.length > 0, "the lead heel never released");

  const first = lifted[0];
  const last = lifted[lifted.length - 1];
  const top = swing.frames.findIndex((frame) => frame.timestampMs >= 1220);
  assert.ok(first > 24 && first < top, `lead heel released at frame ${first}, expected during the backswing`);
  assert.ok(last < top + 30, `lead heel still up at frame ${last}, expected re-planted for the downswing`);
  assert.equal(left[left.length - 1].phase, "planted", "the lead foot should finish planted");

  // Released onto the arc about the toe: the toe stays put while the ankle moves.
  for (const index of lifted) {
    const joints = report.sequence.frames[index].body.joints;
    assert.equal(report.sequence.frames[index].provenance.joints.leftToe.source, "anchored");
    assert.ok(
      distance(joints.leftToe, truth[index].leftToe) < 0.012,
      `lead toe drifted ${(distance(joints.leftToe, truth[index].leftToe) * 1000).toFixed(0)}mm while the heel was up`
    );
  }
});

test("a foot that genuinely leaves the ground is let go", () => {
  const report = reconstruct(observe());
  const right = report.feet!.states.right;

  // The fixture lifts the whole trail foot in the finish -- toe and all --
  // which is beyond what an arc about the toe can explain. The leash must
  // give it up rather than hold it to the floor.
  const finish = swing.frames.findIndex((frame) => frame.timestampMs >= 2050);
  assert.equal(right[finish].phase, "free", `trail foot should be free in the finish, was ${right[finish].phase}`);
  assert.equal(right[right.length - 1].phase, "free");
  assert.ok(report.stageCounts.footReleases >= 1);

  // Once free, the detector's reading stands: no worse than with no leash.
  const off = reconstruct(observe(), { stages: { leashFeet: false } }).sequence;
  const finishFrames = range(finish, right.length);
  const rightFoot: readonly ClarityJoint[] = ["rightAnkle", "rightHeel", "rightToe"];
  assert.ok(
    meanError(report.sequence.frames, rightFoot, finishFrames) <
      meanError(off.frames, rightFoot, finishFrames) + 0.002
  );
});

test("one bad knee frame does not release a foot", () => {
  const clean = observe();
  const victim = 12;
  // Knee reported 8cm further along the stance line for one frame -- a
  // taut tibia by any measure, if it were believed.
  const sequence: WorldObservationSequence = {
    ...clean,
    frames: clean.frames.map((frame, index) => {
      if (index !== victim) return frame;
      const knee = frame.joints.leftKnee!;
      return {
        ...frame,
        joints: {
          ...frame.joints,
          leftKnee: {
            ...knee,
            position: [knee.position[0] + 0.08, knee.position[1], knee.position[2]] as Vec3,
          },
        },
      };
    }),
  };

  // Jump rejection off, so the leash has to cope with the blip itself.
  const report = reconstruct(sequence, { stages: { rejectJumps: false } });
  for (const index of ADDRESS_FRAMES) {
    assert.equal(
      report.feet?.states.left[index].phase,
      "planted",
      `left foot released at frame ${index} on one bad knee frame`
    );
  }
});

test("the leash can be switched off, and then does nothing", () => {
  const report = reconstruct(observe(), { stages: { leashFeet: false } });
  assert.equal(report.feet, null);
  assert.equal(report.stageCounts.feetAnchored, 0);
  for (const frame of report.sequence.frames) {
    for (const joint of FEET) {
      assert.notEqual(frame.provenance.joints[joint].source, "anchored");
    }
  }
});
