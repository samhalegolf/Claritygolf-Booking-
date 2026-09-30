/**
 * Two cameras on one swing, against a body whose true position is known.
 *
 * The fixture films the same synthetic swing from two yaws, starts the second
 * recording late, and squashes each camera's depth to half -- which is what
 * the detector does on real footage (see the README's stance-width table).
 * What has to come back is the offset, the angle between the cameras, the
 * squash, and a body far closer to the truth than either camera alone.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type ClarityFrame } from "../../contracts";
import { buildVideoSequences } from "../../app/videoSequences";
import { anchorSequence } from "../../observe/anchor";
import type { CameraObservationSequence } from "../../observe/observation";
import { detectFromClarityFrames, type SyntheticDetectorOptions } from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { reconstructCalibrated } from "../level/calibrated";
import { fuseTwoViews } from "./twoView";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);
const FRAME_MS = 1000 / 60;

interface Filming extends SyntheticDetectorOptions {
  /** Frames of the swing before this camera started recording. */
  readonly startFrame?: number;
  /** Added to every timestamp: a start between two frames. */
  readonly clockShiftMs?: number;
  /** Timestamps stretched by this -- a slow-motion export. */
  readonly clockRate?: number;
  /** The detector's depth, as a fraction of the truth. */
  readonly depthSquash?: number;
  readonly frames?: readonly ClarityFrame[];
}

const film = ({
  startFrame = 0,
  clockShiftMs = 0,
  clockRate = 1,
  depthSquash = 0.5,
  frames = swing.frames,
  ...detector
}: Filming): CameraObservationSequence => {
  const raw = detectFromClarityFrames(frames.slice(startFrame), { depthNoiseM: 0.04, ...detector });
  return {
    space: "camera",
    frames: raw.map((frame, index) => {
      const camera = toCameraFrame({
        ...frame,
        index,
        timestampMs: index * FRAME_MS * clockRate + clockShiftMs,
      });
      const joints: typeof camera.joints = Object.fromEntries(
        Object.entries(camera.joints).map(([joint, observed]) => [
          joint,
          {
            ...observed,
            position: [observed.position[0], observed.position[1], observed.position[2] * depthSquash],
          },
        ])
      );
      return { ...camera, joints };
    }),
    fps: 60,
    width: 1920,
    height: 1080,
    durationMs: (raw.length / 60) * 1000,
    detector: "synthetic",
  };
};

const errorMm = (frames: readonly ClarityFrame[]) => {
  let total = 0;
  let count = 0;
  for (const frame of frames) {
    for (const joint of CLARITY_JOINTS) {
      total += distance(frame.body.joints[joint], truth[frame.index][joint]);
      count += 1;
    }
  }
  return (total / count) * 1000;
};

const faceOn = film({ cameraYawDeg: 0 });

/* ------------------------------- sync ------------------------------- */

test("the second clip's late start is found to the frame", () => {
  const { report } = fuseTwoViews(faceOn, film({ cameraYawDeg: 90, startFrame: 13 }));
  assert.ok(report.usable, report.reason ?? "");
  assert.equal(report.rate, 1);
  assert.ok(Math.abs(report.offsetMs - -13 * FRAME_MS) < 1, `offset ${report.offsetMs}`);
});

test("a start between two frames is found between them", () => {
  const { report } = fuseTwoViews(faceOn, film({ cameraYawDeg: 90, startFrame: 5, clockShiftMs: 7 }));
  const expected = -5 * FRAME_MS + 7;
  assert.ok(Math.abs(report.offsetMs - expected) < 2, `offset ${report.offsetMs}, expected ${expected}`);
});

test("a slow-motion export is matched at its own clock rate", () => {
  const { report } = fuseTwoViews(faceOn, film({ cameraYawDeg: 90, startFrame: 5, clockRate: 2 }));
  assert.ok(report.usable, report.reason ?? "");
  assert.equal(report.rate, 2);
});

/* ------------------------------ geometry ----------------------------- */

test("the angle between the cameras is measured, square or a little off", () => {
  for (const yaw of [90, 75]) {
    const { report } = fuseTwoViews(faceOn, film({ cameraYawDeg: yaw, startFrame: 9 }));
    assert.ok(Math.abs(report.angleBetweenDeg - yaw) < 4, `${yaw}° read as ${report.angleBetweenDeg}°`);
  }
});

test("each camera's squashed depth is measured from the other", () => {
  const { report } = fuseTwoViews(faceOn, film({ cameraYawDeg: 90, depthSquash: 0.6 }));
  assert.ok(report.depthMeasured);
  assert.ok(Math.abs(report.depthScale.primary - 0.5) < 0.06, `primary ${report.depthScale.primary}`);
  assert.ok(Math.abs(report.depthScale.second - 0.6) < 0.06, `second ${report.depthScale.second}`);
});

test("cameras too close together to see each other's depth say so", () => {
  const { report } = fuseTwoViews(faceOn, film({ cameraYawDeg: 15 }));
  assert.ok(report.usable, report.reason ?? "");
  assert.equal(report.depthMeasured, false);
  assert.deepEqual(report.depthScale, { primary: 1, second: 1 });
});

/* ------------------------------- worth ------------------------------- */

test("face-on and down the line together beat either alone, whichever is on screen", () => {
  const downTheLine = film({ cameraYawDeg: 80, startFrame: 11 });
  for (const [label, primary, second] of [
    ["face-on on screen", faceOn, downTheLine],
    ["down the line on screen", film({ cameraYawDeg: 80 }), film({ cameraYawDeg: 0, startFrame: 11 })],
  ] as const) {
    const alone = errorMm(reconstructCalibrated(primary, null).sequence.frames);
    const fusion = fuseTwoViews(primary, second);
    const together = errorMm(
      reconstructCalibrated(fusion.sequence, null, {
        reconstruct: { stages: { neutralFarSide: false } },
      }).sequence.frames
    );
    assert.ok(together < 20, `${label}: ${together.toFixed(1)}mm fused`);
    assert.ok(together < alone / 3, `${label}: ${alone.toFixed(1)}mm alone, ${together.toFixed(1)}mm fused`);
  }
});

test("an arm the on-screen camera lost is taken from the other, and marked as such", () => {
  const hidden = film({
    cameraYawDeg: 90,
    dropouts: [
      { joint: "rightElbow", startFrame: 20, length: 60 },
      { joint: "rightWrist", startFrame: 20, length: 60 },
    ],
  });
  const { sequence, report } = fuseTwoViews(hidden, faceOn);
  assert.ok(report.addedFromSecond >= 100, `added ${report.addedFromSecond}`);

  const elbow = sequence.frames[40].joints.rightElbow;
  assert.ok(elbow, "the elbow should be filled");
  assert.equal(elbow.views, "second");
  // Its pixel is projected, not seen -- close to where the camera would have seen it.
  const seen = film({ cameraYawDeg: 90 }).frames[40].joints.rightElbow!;
  assert.ok(Math.hypot(elbow.image[0] - seen.image[0], elbow.image[1] - seen.image[1]) < 0.03);
});

/* ------------------------------ refusals ------------------------------ */

test("a clip that is not the same swing is refused, and the swing is left untouched", () => {
  const backwards = film({ cameraYawDeg: 90, frames: [...swing.frames].reverse() });
  const fusion = fuseTwoViews(faceOn, backwards);
  assert.equal(fusion.report.usable, false);
  assert.ok(fusion.report.reason);
  assert.equal(fusion.sequence, faceOn);
});

/* ---------------------------- in the video path ---------------------------- */

test("the baseline stays the on-screen clip alone; the reconstruction uses both", () => {
  const observed = { camera: faceOn, world: anchorSequence(faceOn) };
  const alone = buildVideoSequences(observed, null);
  const both = buildVideoSequences(observed, null, film({ cameraYawDeg: 90, startFrame: 7 }));

  assert.equal(alone.fusion, null);
  assert.ok(both.fusion?.usable);
  assert.deepEqual(both.sequence, alone.sequence);
  assert.ok(errorMm(both.reconstructed.frames) < errorMm(alone.reconstructed.frames) / 3);
  // Nothing on the far side to guess at: the second camera measured it.
  assert.equal(both.levelling.neutral, null);
});
