/**
 * The camera's pitch, read off the stance line's own drop.
 *
 * The line between the ankles is horizontal, so its drop down the image
 * measures the tilt ALONG it -- which is the roll face-on and the PITCH
 * square to the stance. This is the route that works on the view where the
 * roll cannot be measured at all, and it costs the golfer nothing.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type ClarityFrame } from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import type { CameraObservationSequence, ObservationFrame } from "../../observe/observation";
import { detectFromClarityFrames } from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { reconstruct } from "../reconstruct/reconstruct";
import { reconstructCalibrated } from "./calibrated";
import { measureStanceDropCameraPitch } from "./stanceDrop";

const swing = generateSyntheticSwing();
const HEIGHT_M = swing.bodyModel.estimatedHeightM;
const truth = swing.frames.map((frame) => frame.body.joints);

const withCameraRoll = (raw: readonly ObservationFrame[], degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return raw.map((frame) => ({
    ...frame,
    world:
      frame.world?.map((point) => ({ ...point, x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos })) ??
      null,
  }));
};

const filmed = (yawDeg: number, pitchDeg: number, rollDeg = 0): CameraObservationSequence => {
  const raw = withCameraRoll(
    detectFromClarityFrames(swing.frames, { cameraYawDeg: yawDeg, cameraPitchDeg: pitchDeg }),
    rollDeg
  );
  return {
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (raw.length / swing.fps) * 1000,
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
  return count === 0 ? 0 : (total / count) * 1000;
};

/* ------------------------------ what it reads -------------------------- */

test("square to the stance, the drop gives the camera's own pitch", () => {
  /*
   * Measured with the answer known. The estimate carries its own uncertainty
   * and the assertion is against that rather than a flat tolerance, because
   * most of it comes from the stance width being a population figure -- an
   * error that scales with the angle.
   */
  /*
   * Measured with the answer known. The estimate carries its own uncertainty
   * and the assertion is against that rather than a flat tolerance, because
   * most of it comes from the stance width being a population figure -- an
   * error that scales with the angle.
   */
  for (const yawDeg of [90, 75]) {
    for (const cameraPitchDeg of [0, 4, 8, -6]) {
      const result = measureStanceDropCameraPitch(filmed(yawDeg, cameraPitchDeg), HEIGHT_M);
      assert.ok(result.usable, `yaw ${yawDeg}°, tilt ${cameraPitchDeg}°: ${result.reason}`);
      assert.ok(
        Math.abs(result.cameraPitchDeg - cameraPitchDeg) <= result.uncertaintyDeg + 0.3,
        `yaw ${yawDeg}°, tilt ${cameraPitchDeg}°: read ${result.cameraPitchDeg.toFixed(1)}° +/- ${result.uncertaintyDeg.toFixed(1)}`
      );
    }
  }
});

test("and a camera roll does not disturb it", () => {
  /*
   * Square to the stance, a camera roll turns about the lens axis, which is
   * where the stance line already lies -- and a rotation cannot move a vector
   * along its own axis. So the reading is untouched by it.
   */
  const level = measureStanceDropCameraPitch(filmed(90, 6), HEIGHT_M).cameraPitchDeg;
  for (const rollDeg of [-8, -4, 4, 8]) {
    const rolled = measureStanceDropCameraPitch(filmed(90, 6, rollDeg), HEIGHT_M).cameraPitchDeg;
    assert.ok(
      Math.abs(rolled - level) < 0.5,
      `${rollDeg}° of roll moved the pitch reading from ${level.toFixed(2)}° to ${rolled.toFixed(2)}°`
    );
  }
});

test("face-on it declines, because there the same drop is the roll", () => {
  // And the anchor already reads it as such. Two routes claiming the same
  // millimetres would double-count the tilt.
  for (const yawDeg of [0, 20, 45]) {
    const result = measureStanceDropCameraPitch(filmed(yawDeg, 8), HEIGHT_M);
    assert.equal(result.usable, false, `yaw ${yawDeg}° should decline, got ${result.cameraPitchDeg.toFixed(1)}°`);
    assert.match(result.reason ?? "", /along depth/);
  }
});

test("no stature, no angle", () => {
  // The drop is a length; turning it into an angle needs a length to divide
  // by, and the one this view cannot measure is the stance width.
  for (const height of [0, 0.5, 3, Number.NaN]) {
    assert.equal(measureStanceDropCameraPitch(filmed(90, 6), height).usable, false);
  }
});

/* ---------------------------- what it is worth ------------------------- */

test("it corrects a down-the-line clip nothing else can", () => {
  /*
   * The case this exists for, measured against the known body. Square to the
   * stance `estimateLevelling` finds nothing to measure, so without this the
   * tilt goes uncorrected into every reading that compares a height against
   * the ground.
   */
  for (const tiltDeg of [6, 10]) {
    const camera = filmed(90, tiltDeg);

    const plain = anchorSequence(camera);
    assert.equal(
      plain.anchor.gravityTiltIsMeasured,
      false,
      "the image should not be able to level this on its own"
    );

    const before = errorMm(reconstruct(plain).sequence.frames);
    const after = reconstructCalibrated(camera, null);

    assert.ok(after.stanceDrop.usable, `${tiltDeg}°: ${after.stanceDrop.reason}`);
    assert.ok(
      errorMm(after.sequence.frames) < before * 0.75,
      `${tiltDeg}°: ${before.toFixed(0)}mm before, ${errorMm(after.sequence.frames).toFixed(0)}mm after`
    );
  }
});

test("a clip the image CAN level is left to the image", () => {
  // The anchor's own reading needs no assumed stance width, so where it has
  // one it is the better number and this must not override it.
  const camera = filmed(0, 0);
  assert.equal(measureStanceDropCameraPitch(camera, HEIGHT_M).usable, false);
  assert.equal(anchorSequence(camera).anchor.gravityTiltIsMeasured, true);
});
