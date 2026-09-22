/**
 * The shoulder girdle, checked on its promises.
 *
 * Three of them, and the first two pull in opposite directions, which is the
 * point.
 *
 * It is rigid enough to carry a shoulder the detector never saw -- not to
 * the right distance from the other one, which a bone length already did,
 * but to the right PLACE.
 *
 * It is not so rigid that it irons out the movement a real girdle has. A
 * scapula that swings eight degrees on its strut through the clip keeps that
 * movement all the way to the output, and the pair's width narrows with it,
 * while a reading that puts a shoulder somewhere this golfer's girdle never
 * went is still reined back in.
 *
 * And it does not claim more than it can see. The last test here pins the
 * limit: at a physiological swing the allowance does NOT move, because the
 * fit absorbs the travel and what is left is smaller than the detector's own
 * scatter. If that test ever starts failing, the girdle has become able to
 * measure scapular travel and the module header needs rewriting.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  add,
  distance,
  lerpVec,
  normalise,
  qFromAxisAngle,
  qRotate,
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

/** A physiological swing of the struts, fore and aft, degrees. */
const PROTRACTION_DEG = 8;

/**
 * The same swing with the scapulae working.
 *
 * Both shoulders swing forward on their struts and back again over the clip,
 * about the sternum, which is what protraction and retraction do: the strut
 * keeps its length and only its angle changes. The two senses are opposite
 * about the body's own vertical, so both shoulders go forward together and
 * the pair NARROWS rather than turning -- by w(1 - cos(theta)), which is
 * 4mm at eight degrees against 29mm of fore-aft travel.
 *
 * Deliberately symmetric. One shoulder swinging alone is indistinguishable
 * from a degree or two more shoulder turn, and the fit absorbs it as turn --
 * see the module header.
 */
const swungBy = (degrees: number): ClarityFrame[] =>
  swing.frames.map((frame, index) => {
    const joints = frame.body.joints;
    const up = normalise(
      sub(
        lerpVec(joints.leftShoulder, joints.rightShoulder, 0.5),
        lerpVec(joints.leftHip, joints.rightHip, 0.5)
      )
    );
    const phase = Math.sin((index / swing.frames.length) * Math.PI * 2);
    const onStrut = (shoulder: Vec3, sense: number): Vec3 =>
      add(
        joints.sternum,
        qRotate(
          qFromAxisAngle(up, sense * degrees * (Math.PI / 180) * phase),
          sub(shoulder, joints.sternum)
        )
      );
    return {
      ...frame,
      body: {
        ...frame.body,
        joints: {
          ...joints,
          leftShoulder: onStrut(joints.leftShoulder, 1),
          rightShoulder: onStrut(joints.rightShoulder, -1),
        },
      },
    };
  });

const protracting = swungBy(PROTRACTION_DEG);
const protractingTruth = protracting.map((frame) => frame.body.joints);

test("the sternum is placed off the shoulder line and rides with the girdle", () => {
  const report = reconstruct(observe(rigid));
  const template = report.girdle?.template;
  assert.ok(template);

  // A third corner that is not on the line through the other two -- which is
  // the whole reason it exists, since the neck IS that line's midpoint.
  assert.ok(
    Math.abs(template.sternumLocal[1]) > template.widthM * 0.05,
    "the sternum came out on the shoulder line, which makes the girdle a rod again"
  );
  assert.ok(Math.abs(template.sternumLocal[0]) < 1e-9, "the sternum is off the midline");

  for (const frame of report.sequence.frames) {
    const { sternum, leftShoulder, rightShoulder } = frame.body.joints;
    // The struts hold their length. This is the claim the marker is for.
    for (const [side, shoulder] of [["left", leftShoulder], ["right", rightShoulder]] as const) {
      const strut = distance(sternum, shoulder);
      const expected: number =
        template.strutM[side === "left" ? "leftShoulder" : "rightShoulder"];
      assert.ok(
        Math.abs(strut - expected) < 0.02,
        `frame ${frame.index}: ${side} strut ${(strut * 1000).toFixed(0)}mm against ${(expected * 1000).toFixed(0)}mm`
      );
    }
    assert.equal(frame.provenance.joints.sternum.source, "derived");
    // Built, never tracked, so it was never inside a gap either.
    assert.equal(frame.provenance.joints.sternum.gapLength, 0);
  }
});

test("a strut is bone: the clip is not allowed to stretch one", () => {
  const still = reconstruct(observe(rigid)).girdle?.template ?? null;
  const moving = reconstruct(observe(protracting)).girdle?.template ?? null;
  assert.ok(still, "the still girdle was not measured");
  assert.ok(moving, "the flexing girdle was not measured");

  /*
   * The half of the model that must not grow. The shoulders travelled 29mm
   * fore and aft and the distance out from the sternum did not change,
   * because they moved ON the strut rather than off it -- so the slack the
   * clip measures stays the size of the detector's scatter on a shoulder
   * marker, on both clips.
   */
  for (const shoulder of ["leftShoulder", "rightShoulder"] as const) {
    assert.ok(
      moving.strutSlackM[shoulder] < 0.02,
      `${shoulder} strut was given ${(moving.strutSlackM[shoulder] * 1000).toFixed(0)}mm of stretch`
    );
    assert.ok(still.strutSlackM[shoulder] < 0.02);
  }
});

test("the swing allowance is measured off the clip, not set", () => {
  /*
   * Twenty-five degrees, which no scapula does. The exaggeration is the
   * point: at a physiological eight degrees the measurement does NOT move --
   * see the next test for why -- so a clip that tests whether the allowance
   * responds to evidence at all has to swing the struts far enough for the
   * narrowing to clear the detector's own noise.
   */
  const still = reconstruct(observe(rigid)).girdle?.template ?? null;
  const wide = reconstruct(observe(swungBy(25))).girdle?.template ?? null;
  assert.ok(still && wide);

  for (const shoulder of ["leftShoulder", "rightShoulder"] as const) {
    const wideDeg: number = (wide.swingRad[shoulder] * 180) / Math.PI;
    const stillDeg: number = (still.swingRad[shoulder] * 180) / Math.PI;
    assert.ok(
      wideDeg > stillDeg * 1.5,
      `${shoulder}: ${wideDeg.toFixed(1)} degrees against ${stillDeg.toFixed(1)} on a still girdle`
    );
  }
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
     * A girdle held to its resting shape would report each shoulder in the
     * same place all clip and average about 19mm of error -- the mean of the
     * travel it refused to show. Landing near detection noise instead means
     * the movement came through.
     */
    assert.ok(
      error < 0.01,
      `${shoulder} averaged ${(error * 1000).toFixed(0)}mm out on a clip where it swung ${PROTRACTION_DEG} degrees`
    );
  }

  /*
   * And the consequence the struts are for: the pair narrows, and it narrows
   * BY WAY OF the angle rather than by the shoulders being free to slide
   * inward. A reconstruction reporting one constant width has ironed the
   * movement out.
   */
  const widthOf = (joints: Record<ClarityJoint, Vec3>) =>
    distance(joints.leftShoulder, joints.rightShoulder);
  const spread = (values: readonly number[]) => Math.max(...values) - Math.min(...values);
  const truthSpread = spread(protractingTruth.map(widthOf));
  const builtSpread = spread(report.sequence.frames.map((frame) => widthOf(frame.body.joints)));
  assert.ok(
    truthSpread > 0.003,
    `the fixture itself only narrowed by ${(truthSpread * 1000).toFixed(1)}mm`
  );
  assert.ok(
    builtSpread > truthSpread * 0.5,
    `width moved ${(builtSpread * 1000).toFixed(1)}mm against the fixture's ${(truthSpread * 1000).toFixed(1)}mm`
  );
});

test("a physiological scapular swing is below what these landmarks can measure", () => {
  /*
   * THE LIMIT, HELD VISIBLE.
   *
   * Eight degrees of symmetric swing moves each shoulder 29mm fore and aft
   * and narrows the pair by 4mm. The fore-aft part is a slide of the whole
   * pair, and the fit absorbs almost all of it by placing the girdle
   * slightly further forward -- head and hips sit on the girdle's own
   * vertical and object only weakly. What is left over is the 4mm of
   * narrowing, and the detector's scatter on a shoulder marker is larger
   * than that.
   *
   * So the allowance this clip measures is barely different from a clip
   * where nothing moved at all. That is not the stage failing to notice; it
   * is what these four landmarks can tell apart, and the number is worth
   * pinning so nobody later reads the allowance as a measurement of
   * scapular travel.
   */
  const still = reconstruct(observe(rigid)).girdle?.template ?? null;
  const moving = reconstruct(observe(protracting)).girdle?.template ?? null;
  assert.ok(still && moving);

  for (const shoulder of ["leftShoulder", "rightShoulder"] as const) {
    const movingDeg: number = (moving.swingRad[shoulder] * 180) / Math.PI;
    const stillDeg: number = (still.swingRad[shoulder] * 180) / Math.PI;
    assert.ok(
      movingDeg < stillDeg + 2,
      `${shoulder}: ${movingDeg.toFixed(1)} degrees against ${stillDeg.toFixed(1)} still -- ` +
        "if this now separates them, the limit has moved and the note above is out of date"
    );
  }
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
