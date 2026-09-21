/**
 * Telling a tilted camera apart from a bent golfer.
 *
 * Both push the hips backwards in the picture, and pushing the hips back is
 * the main thing a golfer's lower body actually does -- so getting this wrong
 * does not produce an obviously broken reconstruction. It produces a
 * plausible one that is measuring the tripod.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ClarityFrame, ClarityJoint, Vec3 } from "../contracts";
import { generateSyntheticSwing } from "../synthetic/syntheticSwing";
import { anchorSequence } from "./anchor";
import {
  foreAftProfile,
  pitchInvariantOffsets,
  postureShape,
  separateForeAft,
  type ForeAftSample,
} from "./foreAft";
import type {
  CameraObservationSequence,
  ObservationFrame,
  WorldObservationFrame,
} from "./observation";
import { detectFromClarityFrames } from "./syntheticDetector";
import { toCameraFrame } from "./toCameraFrame";

const swing = generateSyntheticSwing();

const buildCameraSequence = (raw: readonly ObservationFrame[]): CameraObservationSequence => ({
  space: "camera",
  frames: raw.map((frame) => toCameraFrame(frame)),
  fps: swing.fps,
  width: 1920,
  height: 1080,
  durationMs: swing.frames.length * (1000 / swing.fps),
  detector: "synthetic",
});

/**
 * Pitch the camera up or down, as a tripod on a slope is.
 *
 * Applied to the detector's WORLD landmarks for the same reason the roll test
 * applies it there: a detector's axes are the image's, so a tilted camera
 * gives tilted world landmarks and calls them upright.
 *
 * A real ROTATION, not the shear it is often approximated by. The difference
 * is what keeps this module's invariance from being perfect, so faking it
 * with a shear would be testing the assumption rather than the code.
 */
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

const run = (frames: readonly ClarityFrame[], pitchDeg: number) =>
  anchorSequence(buildCameraSequence(withCameraPitch(detectFromClarityFrames(frames), pitchDeg)));

/** The hips' fore-aft position relative to the ankles: the reading to beat. */
const hipVsAnkleMm = (frame: WorldObservationFrame): number =>
  (foreAftProfile(frame).find((sample) => sample.name === "hip")?.foreAftM ?? 0) * 1000;

/**
 * A golfer who sits back into the shot: hips back and down, knees forward,
 * everything above the hips carried down with them.
 *
 * Applied to the BODY, before any detector sees it, so it is a real change of
 * posture rather than a change of viewpoint dressed up as one.
 */
const SQUAT: Partial<Record<ClarityJoint, Vec3>> = {
  leftHip: [0, -0.04, 0.06],
  rightHip: [0, -0.04, 0.06],
  leftKnee: [0, -0.02, -0.03],
  rightKnee: [0, -0.02, -0.03],
  leftShoulder: [0, -0.04, 0],
  rightShoulder: [0, -0.04, 0],
  neck: [0, -0.04, 0],
  head: [0, -0.04, 0],
  leftElbow: [0, -0.04, 0],
  rightElbow: [0, -0.04, 0],
  leftWrist: [0, -0.04, 0],
  rightWrist: [0, -0.04, 0],
  leftHand: [0, -0.04, 0],
  rightHand: [0, -0.04, 0],
};

const squatted: readonly ClarityFrame[] = swing.frames.map((frame) => ({
  ...frame,
  body: {
    ...frame.body,
    joints: Object.fromEntries(
      Object.entries(frame.body.joints).map(([name, position]) => {
        const shift = SQUAT[name as ClarityJoint];
        return [
          name,
          shift
            ? [position[0] + shift[0], position[1] + shift[1], position[2] + shift[2]]
            : position,
        ];
      })
    ) as Record<ClarityJoint, Vec3>,
  },
}));

/* ----------------------- what the camera contributes ------------------- */

test("a camera pitch shows up in the profile's slope, one degree for one degree", () => {
  const level = separateForeAft(run(swing.frames, 0)).shape.apparentLeanDeg;

  for (const degrees of [1, 2, 5, 10]) {
    const tilted = separateForeAft(run(swing.frames, degrees)).shape.apparentLeanDeg;
    const recovered = tilted - level;
    // Slightly under one-for-one because the slope is an angle of a fitted
    // line rather than the rotation itself, and the two agree only to first
    // order. At ten degrees that costs a hundredth of a degree per degree.
    assert.ok(
      Math.abs(recovered - degrees) < 0.15 * Math.max(1, degrees / 5),
      `${degrees}° of pitch moved the apparent lean by ${recovered.toFixed(2)}°`
    );
  }
});

test("but the slope is NOT the pitch, so it is not named as though it were", () => {
  /*
   * The tempting shortcut. A camera pitch is exactly linear in height, so
   * regressing fore-aft position on height ought to recover it.
   *
   * It does not, because the golfer is not a plumb line. Address puts the
   * shoulders and head well forward of the ankles and they are also the
   * highest things in the profile, so the posture correlates with height all
   * by itself. This fixture, filmed by a perfectly level camera, regresses to
   * more than ten degrees.
   *
   * Anything that treated that as a camera tilt would then "level" the world
   * by rotating a golfer's genuine address out of the data.
   */
  const level = separateForeAft(run(swing.frames, 0)).shape;
  assert.ok(
    level.apparentLeanDeg > 8,
    `a level camera regressed to ${level.apparentLeanDeg.toFixed(2)}°, which should be large enough to be obviously not the camera`
  );
});

/* --------------------- what survives the camera ------------------------ */

test("the bend in the profile survives a pitch that ruins its slope", () => {
  /*
   * The arithmetic: a pitch adds t*h to every point, so it adds exactly t to
   * the fitted slope and leaves every residual alone. The invariance is not
   * approximate for a shear -- it is identical.
   *
   * It is approximate here only because a real camera ROTATES rather than
   * shears, which also changes the heights by z*sin(theta). That is second
   * order in the fore-aft offsets, and the numbers below are what it costs.
   */
  const baseline = separateForeAft(run(swing.frames, 0)).shape;

  for (const degrees of [1, 2, 5, 10]) {
    const tilted = separateForeAft(run(swing.frames, degrees)).shape;

    const naive =
      Math.abs(hipVsAnkleMm(run(swing.frames, degrees).frames[0]) - hipVsAnkleMm(run(swing.frames, 0).frames[0]));
    const invariant = Math.abs(tilted.hipSetBackM - baseline.hipSetBackM) * 1000;

    // 15mm per degree naively -- the hip is 870mm up -- against 0.7mm per
    // degree for the residual. Twenty times better, and the gap widens the
    // more the profile is a bend rather than a slope.
    assert.ok(
      invariant < 1.0 * degrees,
      `${degrees}° of pitch moved the invariant hip reading by ${invariant.toFixed(1)}mm`
    );
    assert.ok(
      invariant * 8 < naive,
      `at ${degrees}° the naive reading moved ${naive.toFixed(1)}mm and the invariant one ${invariant.toFixed(1)}mm -- not a big enough separation to be worth the machinery`
    );
  }
});

test("removing any linear-in-height term is what makes the residual pitch-proof", () => {
  // The claim, checked directly rather than through the pipeline: shear the
  // samples and the offsets do not move at all.
  const samples: readonly ForeAftSample[] = [
    { name: "ankle", heightM: 0, foreAftM: 0 },
    { name: "knee", heightM: 0.44, foreAftM: 0.045 },
    { name: "hip", heightM: 0.87, foreAftM: 0 },
    { name: "shoulder", heightM: 1.31, foreAftM: 0.275 },
    { name: "head", heightM: 1.5, foreAftM: 0.366 },
  ];
  const sheared = samples.map((sample) => ({
    ...sample,
    foreAftM: sample.foreAftM + Math.tan((7 * Math.PI) / 180) * sample.heightM,
  }));

  const before = pitchInvariantOffsets(samples);
  const after = pitchInvariantOffsets(sheared);
  for (const [name, offset] of before) {
    assert.ok(
      Math.abs((after.get(name) ?? 0) - offset) < 1e-12,
      `${name} moved by ${(((after.get(name) ?? 0) - offset) * 1000).toFixed(6)}mm under a pure shear`
    );
  }
});

/* ------------------- telling the two apart, which is the point --------- */

test("a camera pitch can erase a genuine squat from the naive reading", () => {
  /*
   * The failure this module exists to prevent, stated as a number.
   *
   * A golfer sits back 60mm. Film them with the camera pitched five degrees
   * and the hips read as being in FRONT of the ankles. Not attenuated, not
   * noisy -- the wrong sign.
   */
  // Measured along the toe direction, so a set-back is NEGATIVE: away from
  // the toes. Which way that is in world coordinates is the module's problem,
  // not this test's -- that is the whole point of measuring it from the feet.
  const trueSetBack = hipVsAnkleMm(run(squatted, 0).frames[0]);
  const asFilmed = hipVsAnkleMm(run(squatted, 5).frames[0]);

  assert.ok(trueSetBack < -50, `the squat should read about -60mm, read ${trueSetBack.toFixed(1)}mm`);
  assert.ok(
    asFilmed > 0,
    `five degrees of pitch should flip the sign of a 60mm set-back; it read ${asFilmed.toFixed(1)}mm`
  );
});

test("and the invariant reading keeps it", () => {
  const level = separateForeAft(run(swing.frames, 0)).shape;
  const pitched = separateForeAft(run(swing.frames, 5)).shape;
  const squat = separateForeAft(run(squatted, 0)).shape;

  const fromCamera = Math.abs(pitched.hipSetBackM - level.hipSetBackM) * 1000;
  const fromGolfer = Math.abs(squat.hipSetBackM - level.hipSetBackM) * 1000;

  // ~3mm of leakage against ~51mm of signal.
  assert.ok(
    fromGolfer > 10 * fromCamera,
    `a five-degree pitch moved the reading ${fromCamera.toFixed(1)}mm and a real squat ${fromGolfer.toFixed(1)}mm`
  );

  // The knee is better still: it sits low, so it has less height for a tilt
  // to work with, while a squat moves it forward over the foot.
  const kneeFromCamera = Math.abs(pitched.kneeOverM - level.kneeOverM) * 1000;
  const kneeFromGolfer = Math.abs(squat.kneeOverM - level.kneeOverM) * 1000;
  assert.ok(
    kneeFromGolfer > 20 * kneeFromCamera,
    `knee: ${kneeFromCamera.toFixed(1)}mm from the camera, ${kneeFromGolfer.toFixed(1)}mm from the golfer`
  );
});

test("the two channels stay additive, so a squat filmed on a tilt is still readable", () => {
  const level = separateForeAft(run(swing.frames, 0)).shape;
  const squat = separateForeAft(run(squatted, 0)).shape;
  const both = separateForeAft(run(squatted, 5)).shape;

  const predicted = squat.hipSetBackM + (separateForeAft(run(swing.frames, 5)).shape.hipSetBackM - level.hipSetBackM);
  assert.ok(
    Math.abs(both.hipSetBackM - predicted) * 1000 < 2,
    `squat-on-a-tilt read ${(both.hipSetBackM * 1000).toFixed(1)}mm, camera and golfer added to ${(predicted * 1000).toFixed(1)}mm`
  );
});

/* ------------------------------ honesty -------------------------------- */

test("the stance filter does not quietly vanish when the pitch gets large", () => {
  /*
   * The first version of this required every foot point within 30mm of the
   * ground. A ten-degree pitch raises the toes 35mm above the heels on a
   * 200mm foot, so EVERY frame failed and the whole measurement silently
   * returned nothing -- at exactly the tilt it was most needed for.
   */
  const level = separateForeAft(run(swing.frames, 0));
  for (const degrees of [2, 5, 10]) {
    const tilted = separateForeAft(run(swing.frames, degrees));
    assert.ok(
      tilted.samples > level.samples * 0.8,
      `at ${degrees}° only ${tilted.samples} frames passed the stance filter, against ${level.samples} when level`
    );
  }
});

test("a golfer shaped like a plumb line cannot be separated, and says so", () => {
  // No bend means no residual, which means nothing a camera pitch could not
  // have produced. The right answer is to decline, not to report zero.
  const straight: WorldObservationFrame = {
    space: "world",
    index: 0,
    timestampMs: 0,
    detected: true,
    club: null,
    joints: Object.fromEntries(
      (
        [
          // Feet first: the toe direction is MEASURED from them, so a body
          // with no feet has no fore-aft axis to be measured along at all.
          // Toes on -Z, which is where a real golfer's are. See units.ts.
          ["leftHeel", 0.03, 0.06], ["rightHeel", 0.03, 0.06],
          ["leftToe", 0.02, -0.14], ["rightToe", 0.02, -0.14],
          ["leftAnkle", 0.08, 0], ["rightAnkle", 0.08, 0],
          ["leftKnee", 0.5, 0], ["rightKnee", 0.5, 0],
          ["leftHip", 0.95, 0], ["rightHip", 0.95, 0],
          ["leftShoulder", 1.45, 0], ["rightShoulder", 1.45, 0],
          ["head", 1.65, 0],
        ] as const
      ).map(([name, height, footZ]) => [
        name,
        {
          /*
           * Perfectly linear in height: a five-degree lean and nothing else.
           * Negated because the toes are on -Z, so leaning TOWARD them is
           * the -Z direction -- which is exactly the sign this module now
           * measures rather than assumes.
           */
          position: [0, height, footZ - height * Math.tan((5 * Math.PI) / 180)] as const,
          image: [0.5, 0.5] as const,
          visibility: 1,
          presence: 1,
          sourceCount: 1,
        },
      ])
    ),
  };

  const shape = postureShape(straight);
  assert.ok(
    shape.linearFractionUnit > 0.999,
    `a straight body left ${((1 - shape.linearFractionUnit) * 100).toFixed(2)}% of its profile unexplained by a tilt`
  );
  assert.ok(Math.abs(shape.hipSetBackM) < 0.001);
  assert.ok(Math.abs(shape.apparentLeanDeg - 5) < 0.01, "the lean itself is still measured");
});

test("fewer than three rungs is a line, not a shape", () => {
  const frame = run(swing.frames, 0).frames[0];
  const cropped: WorldObservationFrame = {
    ...frame,
    joints: {
      leftAnkle: frame.joints.leftAnkle,
      rightAnkle: frame.joints.rightAnkle,
      leftHip: frame.joints.leftHip,
      rightHip: frame.joints.rightHip,
    },
  };
  assert.equal(postureShape(cropped).samples.length, 0, "two rungs should yield no shape");
  assert.equal(postureShape(cropped).hipSetBackM, 0);
});

test("a real clip reports enough height and enough bend to be worth reading", () => {
  const separation = separateForeAft(run(swing.frames, 0));
  assert.ok(separation.separable);
  assert.ok(separation.shape.spanM > 1.4, `spanned ${separation.shape.spanM.toFixed(2)}m`);
  assert.ok(
    separation.shape.linearFractionUnit < 0.9,
    `${(separation.shape.linearFractionUnit * 100).toFixed(0)}% of the profile was explainable as a tilt`
  );
});
