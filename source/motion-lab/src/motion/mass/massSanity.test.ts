/**
 * Checking the fore-aft mass reading against the body's own shape.
 *
 * The reading is the most pitch-sensitive number the pipeline produces -- 16mm
 * of travel per degree of camera tilt, on a foot 265mm long -- and a tilted
 * tripod leaves no trace in the picture. These tests are about what can still
 * be said without ever calibrating the camera.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { distance, type ClarityFrame, type ClarityJoint, type Vec3 } from "../../contracts";
import { lookupFrom, type JointLookup } from "../../observe/foreAft";
import { anchorSequence } from "../../observe/anchor";
import type { CameraObservationSequence, ObservationFrame } from "../../observe/observation";
import { detectFromClarityFrames } from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { passthroughSequence } from "../passthrough";
import { reconstruct } from "../reconstruct/reconstruct";
import { checkMassAgainstShape, readMass } from "./massSanity";

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

/** A real rotation about the stance line, as a tripod on a slope gives. */
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

const bodiesOf = (frames: readonly ClarityFrame[], pitchDeg: number): readonly JointLookup[] =>
  anchorSequence(buildCameraSequence(withCameraPitch(detectFromClarityFrames(frames), pitchDeg)))
    .frames.filter((frame) => frame.detected)
    .map(lookupFrom);

/** The fixture's own stature, which the base of support is derived from. */
const HEIGHT_M = swing.bodyModel.estimatedHeightM;

const check = (frames: readonly ClarityFrame[], pitchDeg: number) =>
  checkMassAgainstShape(bodiesOf(frames, pitchDeg), HEIGHT_M);

/**
 * A golfer who sits back into the shot. Applied to the body, not the camera.
 *
 * Hips move to +Z and knees to -Z, because a golfer's toes point along -Z:
 * sitting back is moving AWAY from the toes. See `contracts/units`.
 */
const SQUAT: Partial<Record<ClarityJoint, Vec3>> = {
  leftHip: [0, -0.04, 0.06], rightHip: [0, -0.04, 0.06],
  leftKnee: [0, -0.02, -0.03], rightKnee: [0, -0.02, -0.03],
  leftShoulder: [0, -0.04, 0], rightShoulder: [0, -0.04, 0],
  neck: [0, -0.04, 0], head: [0, -0.04, 0],
  leftElbow: [0, -0.04, 0], rightElbow: [0, -0.04, 0],
  leftWrist: [0, -0.04, 0], rightWrist: [0, -0.04, 0],
  leftHand: [0, -0.04, 0], rightHand: [0, -0.04, 0],
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

const PITCHES = [0, 2, 5, 10, -5, -10] as const;

/* ------------------------------ soundness ------------------------------ */

test("the admissible pitch interval never excludes the truth", () => {
  /*
   * The property everything else rests on. The interval comes from a physical
   * fact -- a golfer standing on both feet has their mass over their feet --
   * so the real camera angle MUST be inside it. An interval that could
   * exclude the truth would be worse than no interval, because it would be
   * confidently wrong rather than merely wide.
   */
  for (const degrees of PITCHES) {
    const [low, high] = check(swing.frames, degrees).pitchRangeDeg;
    assert.ok(
      degrees >= low - 0.01 && degrees <= high + 0.01,
      `a true pitch of ${degrees}° fell outside the admissible range [${low.toFixed(1)}, ${high.toFixed(1)}]`
    );
  }
});

test("the correction is never larger than the physics forces", () => {
  // Over-correcting would be inventing a camera angle, which is the exact
  // failure the whole module is built to avoid.
  for (const degrees of PITCHES) {
    const { fallingOverPitchDeg } = check(swing.frames, degrees);
    assert.ok(
      Math.abs(fallingOverPitchDeg) <= Math.abs(degrees) + 0.01,
      `a ${degrees}° pitch drew a ${fallingOverPitchDeg.toFixed(2)}° correction`
    );
    assert.ok(
      fallingOverPitchDeg === 0 || Math.sign(fallingOverPitchDeg) === Math.sign(degrees),
      `a ${degrees}° pitch drew a correction of the wrong sign, ${fallingOverPitchDeg.toFixed(2)}°`
    );
  }
});

test("a level camera draws no correction at all", () => {
  const level = check(swing.frames, 0);
  assert.equal(level.fallingOverPitchDeg, 0);
  assert.equal(level.verdict, "consistent");
  assert.equal(level.impossibleFrames, 0);
});

/* --------------------------- what it catches --------------------------- */

test("a mass reading beyond the toes is impossible, and proves a pitch", () => {
  /*
   * At ten degrees the fixture's mass reads past the toes: the golfer would
   * be falling forwards. No posture explains that, so the excess is a hard
   * lower bound on the camera. It recovers about six of the ten degrees --
   * not all, because the reading only has to get back to the toe line to
   * become possible, not back to where it truly was.
   */
  const tilted = check(swing.frames, 10);
  assert.ok(
    tilted.reading.footFractionUnit > 1,
    `the raw reading was ${tilted.reading.footFractionUnit.toFixed(3)} of the foot, which should be impossible`
  );
  assert.equal(tilted.verdict, "corrected");
  assert.ok(
    tilted.fallingOverPitchDeg > 3,
    `only ${tilted.fallingOverPitchDeg.toFixed(2)}° was proven from a reading that far outside the foot`
  );
  assert.ok(
    tilted.correctedFootFractionUnit <= 1.001 && tilted.correctedFootFractionUnit >= -0.001,
    `the corrected reading, ${tilted.correctedFootFractionUnit.toFixed(3)}, is still outside the foot`
  );

  // Fifteen degrees is further outside, so more of it is provable.
  assert.ok(check(swing.frames, 15).fallingOverPitchDeg > tilted.fallingOverPitchDeg);
});

test("more tilt is caught than not, but the clip has to get near the edge to pin it", () => {
  // Two degrees leaves the mass at 89% of the foot -- ugly, entirely possible,
  // and therefore unprovable. Saying so is the honest answer; a module that
  // reported a pitch here would be guessing.
  const small = check(swing.frames, 2);
  assert.ok(small.reading.footFractionUnit < 1);
  assert.equal(small.fallingOverPitchDeg, 0);
  assert.equal(small.verdict, "consistent");
  // and it says the reading is not pinned down
  assert.ok(small.confidence < 0.6, `confidence was ${small.confidence.toFixed(2)}`);
});

/* ---------------------- the bend is the stable part -------------------- */

test("the bend holds the mass reading still while the raw one runs away", () => {
  const level = check(swing.frames, 0).reading;
  const tilted = check(swing.frames, 10).reading;

  const rawMm = Math.abs(tilted.footFractionUnit - level.footFractionUnit) * level.footSpanM * 1000;
  const bendMm = Math.abs(tilted.bendFractionUnit - level.bendFractionUnit) * level.footSpanM * 1000;

  // ~175mm against ~10mm over ten degrees.
  assert.ok(rawMm > 100, `ten degrees moved the raw reading only ${rawMm.toFixed(0)}mm`);
  assert.ok(
    bendMm * 10 < rawMm,
    `the bend moved ${bendMm.toFixed(1)}mm against the raw reading's ${rawMm.toFixed(0)}mm -- not a big enough separation to be worth the machinery`
  );
});

test("a real squat moves the bend; a camera pitch does not", () => {
  const level = check(swing.frames, 0).reading;
  const pitched = check(swing.frames, 5).reading;
  const squat = check(squatted, 0).reading;

  const fromCamera = Math.abs(pitched.bendFractionUnit - level.bendFractionUnit);
  const fromGolfer = Math.abs(squat.bendFractionUnit - level.bendFractionUnit);
  assert.ok(
    fromGolfer > 2 * fromCamera,
    `the bend moved ${(fromCamera * 100).toFixed(1)}% of the foot for the camera and ${(fromGolfer * 100).toFixed(1)}% for a real squat`
  );

  // And the squat moves the mass toward the heels, which is what sitting back
  // means -- so the two readings corroborate rather than merely coexist.
  assert.ok(squat.bendFractionUnit < level.bendFractionUnit);
  assert.ok(squat.footFractionUnit < level.footFractionUnit);
});

test("the clip's own movement is reported split between bend and lean", () => {
  // Both are ranges, and a constant pitch cancels out of a difference, so
  // both numbers are pitch-free however badly the camera was set up.
  const level = check(swing.frames, 0);
  const tilted = check(swing.frames, 5);
  assert.ok(level.bendRangeM > 0.01, `the bend moved the mass only ${(level.bendRangeM * 1000).toFixed(0)}mm`);
  assert.ok(
    Math.abs(tilted.bendRangeM - level.bendRangeM) * 1000 < 2,
    `five degrees changed the bend's range by ${((tilted.bendRangeM - level.bendRangeM) * 1000).toFixed(1)}mm`
  );
});

/* ------------------------------- honesty ------------------------------- */

test("the tight mid-foot band is NOT sound on this fixture, which is why it is not the default", () => {
  /*
   * Narrowing the band to "a still golfer stands near mid-foot" would sharpen
   * the interval from about 15 degrees wide to under 4 -- a four-fold gain,
   * and almost certainly true of real people.
   *
   * It is not true of this fixture. Its address leans the spine forward
   * without pushing the hips back to counterbalance, so its mass genuinely
   * sits at 76% of the foot. Asked to force that into a mid-foot band, the
   * check "proves" two degrees of tilt on a perfectly level camera.
   *
   * That is the fixture's flaw rather than the method's, and the test exists
   * so nobody tightens the default until real footage says where people
   * actually stand.
   */
  const tight = checkMassAgainstShape(bodiesOf(swing.frames, 0), HEIGHT_M, {
    fallingOverBoundary: [0.35, 0.65],
  });
  const [low, high] = tight.pitchRangeDeg;

  assert.ok(high - low < 5, `the tight band should be sharp; it spanned ${(high - low).toFixed(1)}°`);
  assert.ok(
    low > 0.01,
    "the tight band is expected to exclude the true, level camera on this fixture -- if it no longer does, the fixture's address posture has been fixed and this default should be revisited"
  );
});

test("no planted frames means no answer, rather than a plausible one", () => {
  const footless: JointLookup[] = bodiesOf(swing.frames, 0).map((lookup) => (joint) =>
    joint === "leftHeel" || joint === "rightHeel" || joint === "leftToe" || joint === "rightToe"
      ? undefined
      : lookup(joint)
  );
  const result = checkMassAgainstShape(footless, HEIGHT_M);
  assert.equal(result.verdict, "undetermined");
  assert.equal(result.samples, 0);
  assert.equal(result.confidence, 0);
});

test("a body missing any mass parcel yields no reading", () => {
  const [first] = bodiesOf(swing.frames, 0);
  const footLengthM = HEIGHT_M * 0.152;
  assert.ok(readMass(first, footLengthM), "the complete body reads");
  assert.equal(
    readMass((joint) => (joint === "leftElbow" ? undefined : first(joint)), footLengthM),
    null,
    "half a mass cloud is not a mass reading"
  );
});

/* ------------------------- reaching the contract ----------------------- */

test("the finished sequence carries the verdict, and nothing else has moved", () => {
  /*
   * The wiring test. The check runs on the reconstructed bodies and lands on
   * `ClaritySequence` -- which is the only way the 3D Space or the readout can
   * see it, since they consume the contract and nothing else.
   *
   * What it must NOT have done is change a coordinate. The correction is
   * reported, not applied: the levelling that produced these positions lives
   * in `observe/`, which may not import this layer, so applying it would mean
   * re-levelling the whole sequence. That is a separate decision.
   */
  const build = (degrees: number) =>
    reconstruct(
      anchorSequence(buildCameraSequence(withCameraPitch(detectFromClarityFrames(swing.frames), degrees)))
    ).sequence;

  const level = build(0);
  const tilted = build(10);

  assert.ok(level.massSanity, "a clean clip should produce a verdict");
  assert.equal(level.massSanity?.verdict, "consistent");
  assert.equal(level.massSanity?.fallingOverPitchDeg, 0);

  assert.equal(tilted.massSanity?.verdict, "corrected");
  assert.ok((tilted.massSanity?.fallingOverPitchDeg ?? 0) > 1);

  // The geometry is untouched: the tilted clip's joints are exactly where the
  // anchoring left them, five degrees of error and all.
  const observed = anchorSequence(
    buildCameraSequence(withCameraPitch(detectFromClarityFrames(swing.frames), 10))
  );
  const frame = tilted.frames[0];
  const anchorFrame = observed.frames[0];
  for (const joint of ["leftAnkle", "leftHip", "head"] as const) {
    const before = anchorFrame.joints[joint];
    if (!before) continue;
    assert.ok(
      distance(frame.body.joints[joint], before.position as Vec3) < 0.05,
      `${joint} moved ${(distance(frame.body.joints[joint], before.position as Vec3) * 1000).toFixed(0)}mm -- the check should report, not correct`
    );
  }
});

test("a clip with no observed feet reports no verdict rather than a reassuring one", () => {
  const footless = reconstruct(
    anchorSequence(
      buildCameraSequence(
        detectFromClarityFrames(swing.frames, {
          dropouts: (["leftHeel", "rightHeel", "leftToe", "rightToe"] as const).map((joint) => ({
            joint,
            startFrame: 0,
            length: swing.frames.length,
          })),
        })
      )
    )
  ).sequence;

  assert.equal(footless.massSanity, null, "invented feet must not be checked against");
});

test("the passthrough reaches the same verdict as the Motion Layer", () => {
  // The check is about the camera and the golfer, not about how much
  // reconstruction happened, so it should not care which layer produced the
  // bodies.
  const observed = anchorSequence(
    buildCameraSequence(withCameraPitch(detectFromClarityFrames(swing.frames), 5))
  );
  const raw = passthroughSequence(observed);
  const built = reconstruct(observed).sequence;

  assert.equal(raw.massSanity?.verdict, built.massSanity?.verdict);
  assert.ok(
    Math.abs((raw.massSanity?.fallingOverPitchDeg ?? 0) - (built.massSanity?.fallingOverPitchDeg ?? 0)) < 0.5,
    `passthrough proved ${raw.massSanity?.fallingOverPitchDeg.toFixed(2)}° and the Motion Layer ${built.massSanity?.fallingOverPitchDeg.toFixed(2)}°`
  );
});

/* ---------------------------- the foot model --------------------------- */

test("the base of support comes from the golfer's height, not from the foot landmarks", () => {
  /*
   * THE FAILURE THIS PREVENTS, REPRODUCED.
   *
   * A foot points almost entirely along the depth axis, which is a detector's
   * weakest, and face-on it is foreshortened on top of that. On a real
   * face-on clip MediaPipe measured the heel-to-toe distance as 119mm where
   * anatomy puts an adult's foot near 265mm. Used as the support polygon that
   * halves the base of support and doubles every fraction computed against
   * it -- which is most of the way to the 221%-of-foot reading that clip
   * produced.
   *
   * So the feet give the DIRECTION and the golfer's stature gives the LENGTH.
   * Here the foot landmarks are squashed to 45% along their own axis, exactly
   * as the real clip's were, and the reading must not move.
   */
  const squashFeet = (bodies: readonly JointLookup[]): JointLookup[] =>
    bodies.map((lookup) => (joint) => {
      const position = lookup(joint);
      if (!position) return undefined;
      if (joint !== "leftToe" && joint !== "rightToe") return position;
      const heel = lookup(joint === "leftToe" ? "leftHeel" : "rightHeel");
      if (!heel) return position;
      // Pull the toe back toward the heel, leaving everything else alone.
      return [
        heel[0] + (position[0] - heel[0]) * 0.45,
        position[1],
        heel[2] + (position[2] - heel[2]) * 0.45,
      ] as Vec3;
    });

  const honest = checkMassAgainstShape(bodiesOf(swing.frames, 0), HEIGHT_M);
  const squashed = checkMassAgainstShape(squashFeet(bodiesOf(swing.frames, 0)), HEIGHT_M);

  assert.ok(
    Math.abs(squashed.reading.footSpanM - honest.reading.footSpanM) < 0.001,
    `the support polygon moved from ${(honest.reading.footSpanM * 1000).toFixed(0)}mm to ${(squashed.reading.footSpanM * 1000).toFixed(0)}mm when only the landmarks changed`
  );
  assert.ok(
    Math.abs(squashed.reading.footFractionUnit - honest.reading.footFractionUnit) < 0.02,
    `the heel-toe reading moved from ${honest.reading.footFractionUnit.toFixed(3)} to ${squashed.reading.footFractionUnit.toFixed(3)} on squashed feet`
  );
});

test("and the disagreement is reported, because it says the depth axis is unreliable", () => {
  /*
   * The foot is a known length pointing almost entirely along depth, which
   * makes it the clearest view the pipeline has of how much that axis can be
   * trusted on a given clip. Clean synthetic data agrees with anatomy to
   * within a few percent; the real face-on clip came back at 0.45.
   */
  const honest = checkMassAgainstShape(bodiesOf(swing.frames, 0), HEIGHT_M);
  assert.ok(
    Math.abs(honest.reading.footScaleUnit - 1) < 0.1,
    `clean data should measure its own feet about right, got ${honest.reading.footScaleUnit.toFixed(3)}`
  );
});

test("without a height there is no base of support, and it declines", () => {
  // Falling back to the measured span would quietly reintroduce the error
  // this exists to avoid, on exactly the clips where it bites hardest.
  for (const height of [0, 0.4, 3.5, Number.NaN]) {
    const result = checkMassAgainstShape(bodiesOf(swing.frames, 0), height);
    assert.equal(result.verdict, "undetermined", `height ${height} should not produce a verdict`);
  }
});
