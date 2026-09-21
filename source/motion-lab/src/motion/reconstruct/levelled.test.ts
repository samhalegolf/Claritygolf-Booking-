/**
 * Levelling the world against the falling-over boundary.
 *
 * The claim under test is narrow and worth stating plainly: applying the
 * correction makes the reconstruction MEASURABLY CLOSER TO TRUTH, and leaves
 * a clip that needed no correction exactly where it was. A correction that
 * only made the readout look tidier would not be worth the second pass.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type ClarityJoint, type Vec3 } from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import type { CameraObservationSequence, ObservationFrame } from "../../observe/observation";
import { detectFromClarityFrames } from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { reconstructLevelled } from "./levelled";
import { reconstruct } from "./reconstruct";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);

const buildCameraSequence = (raw: readonly ObservationFrame[]): CameraObservationSequence => ({
  space: "camera",
  frames: raw.map((frame) => toCameraFrame(frame)),
  fps: swing.fps,
  width: 1920,
  height: 1080,
  durationMs: swing.frames.length * (1000 / swing.fps),
  detector: "synthetic",
});

const withCameraPitch = (raw: readonly ObservationFrame[], degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return raw.map((frame) => ({
    ...frame,
    world:
      frame.world?.map((point) => ({
        ...point,
        y: point.y * cos - point.z * sin,
        z: point.y * sin + point.z * cos,
      })) ?? null,
  }));
};

const cameraAt = (degrees: number) =>
  buildCameraSequence(withCameraPitch(detectFromClarityFrames(swing.frames), degrees));

/** Mean joint error against the known body, millimetres. The only score that counts. */
const errorMm = (frames: readonly { index: number; body: { joints: Record<ClarityJoint, Vec3> } }[]) => {
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

/* ---------------------- does it actually help? ------------------------- */

test("correcting to the boundary moves the body closer to where it really was", () => {
  /*
   * The test that justifies the whole mechanism. Everything else here could
   * pass while the correction made the reconstruction worse.
   *
   * Measured: five degrees of pitch costs 73mm of mean joint error and the
   * correction recovers it to 50mm; ten degrees costs 145mm and comes back to
   * 42mm. The recovery is larger at ten degrees because the mass has to travel
   * further past the toes before the boundary notices it at all.
   */
  for (const degrees of [5, 10]) {
    const camera = cameraAt(degrees);
    const before = errorMm(reconstruct(anchorSequence(camera)).sequence.frames);
    const levelled = reconstructLevelled(camera);
    const after = errorMm(levelled.sequence.frames);

    assert.ok(levelled.corrected, `${degrees}° drew no correction at all`);
    assert.ok(
      after < before * 0.8,
      `${degrees}° of pitch: ${before.toFixed(0)}mm before, ${after.toFixed(0)}mm after -- not enough of a gain to justify a second pass`
    );
  }
});

test("a clip that never reaches the boundary is left exactly alone", () => {
  /*
   * Two degrees leaves the mass at 89% of the foot: ugly, and entirely
   * possible. Touching it would be inventing a camera angle, and the bodies
   * must come back bit-for-bit identical rather than merely close.
   */
  for (const degrees of [0, 2]) {
    const camera = cameraAt(degrees);
    const plain = reconstruct(anchorSequence(camera)).sequence;
    const levelled = reconstructLevelled(camera);

    assert.equal(levelled.corrected, false);
    assert.equal(levelled.pitchCorrectionDeg, 0);
    assert.equal(levelled.sequence.anchor.pitchCorrectionDeg, 0);

    for (const frame of levelled.sequence.frames) {
      for (const joint of CLARITY_JOINTS) {
        assert.deepEqual(
          frame.body.joints[joint],
          plain.frames[frame.index].body.joints[joint],
          `${joint} moved on a clip that needed no correction`
        );
      }
    }
  }
});

test("the correction never overshoots the pitch that was really there", () => {
  // Over-correcting would be worse than doing nothing: it would rotate a real
  // golfer's posture away on evidence that only ever supported a lower bound.
  for (const degrees of [0, 2, 5, 10, -5, -10]) {
    const { pitchCorrectionDeg } = reconstructLevelled(cameraAt(degrees));
    assert.ok(
      Math.abs(pitchCorrectionDeg) <= Math.abs(degrees) + 0.01,
      `a ${degrees}° pitch drew a ${pitchCorrectionDeg.toFixed(2)}° correction`
    );
  }
});

/* -------------------------- what it records ---------------------------- */

test("the applied pitch is on the record, with its sign", () => {
  const levelled = reconstructLevelled(cameraAt(5));
  assert.ok(levelled.pitchCorrectionDeg > 1);
  // The anchor carries the rotation that was APPLIED, which undoes the
  // camera's, so it is the other way round.
  assert.equal(
    levelled.sequence.anchor.pitchCorrectionDeg,
    -levelled.pitchCorrectionDeg
  );
});

test("after correcting, the mass sits inside the boundary and nothing more is forced", () => {
  const levelled = reconstructLevelled(cameraAt(10));
  const sanity = levelled.sequence.massSanity;
  assert.ok(sanity);
  assert.equal(sanity?.verdict, "consistent");
  assert.equal(sanity?.fallingOverPitchDeg, 0);
  assert.ok(
    (sanity?.reading.footFractionUnit ?? 2) <= 1.001,
    `the mass still reads at ${sanity?.reading.footFractionUnit.toFixed(3)} of the foot after correction`
  );
});

test("reportOnly measures the same angle and leaves the world where it was", () => {
  // For showing the two side by side, and for anyone who would rather have a
  // scene that is wrong predictably than one silently rotated underneath them.
  const camera = cameraAt(5);
  const applied = reconstructLevelled(camera);
  const reported = reconstructLevelled(camera, { reportOnly: true });

  assert.ok(Math.abs(reported.pitchCorrectionDeg - applied.pitchCorrectionDeg) < 0.01);
  assert.equal(reported.corrected, false);
  assert.equal(reported.sequence.anchor.pitchCorrectionDeg, 0);
  assert.ok(
    errorMm(reported.sequence.frames) > errorMm(applied.sequence.frames),
    "reporting only should leave the uncorrected error in place"
  );
});

/* ------------------------------ honesty -------------------------------- */

test("a tilt away from the edge the golfer is already near goes uncaught, and says so", () => {
  /*
   * The boundary can only catch a tilt that pushes the golfer TOWARD an edge
   * they were already close to. This fixture's address puts its mass at 76% of
   * the foot, so tipping it further forward is caught quickly and tipping it
   * back has most of the foot to travel through first.
   *
   * That asymmetry is the fixture's posture, not a flaw in the method -- a
   * golfer standing nearer mid-foot would be caught about equally either way.
   * The test exists so the limit is visible rather than discovered later on
   * real footage.
   */
  const back = reconstructLevelled(cameraAt(-10));
  assert.equal(back.corrected, false, "ten degrees of backward pitch was expected to go uncaught here");

  const forward = reconstructLevelled(cameraAt(10));
  assert.ok(forward.corrected, "ten degrees of forward pitch should be caught");
});

test("running the leveller twice changes nothing the second time", () => {
  // The correction moves the mass onto the boundary by construction, so a
  // second ask has nothing left to find. If it did, the loop would be chasing
  // detector noise around the edge of the foot.
  const once = reconstructLevelled(cameraAt(10));
  const twice = reconstructLevelled(cameraAt(10), {
    anchor: { pitchCorrectionDeg: once.sequence.anchor.pitchCorrectionDeg },
  });
  assert.ok(
    Math.abs(twice.pitchCorrectionDeg) < 0.3,
    `a second pass wanted another ${twice.pitchCorrectionDeg.toFixed(2)}°`
  );
});
