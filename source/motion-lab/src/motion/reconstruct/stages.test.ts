/**
 * The reconstruction stages, tested individually.
 *
 * Each one has a specific promise the plan makes. These check the promise,
 * not the implementation -- in particular that smoothing preserves genuine
 * acceleration and that jump rejection does not mistake a downswing for an
 * error, because those are the two places where a filter that "works" can
 * quietly destroy the thing being measured.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { add, distance, normalise, scale, sub, type Vec3 } from "../../contracts";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { measureBodyModel } from "./bodyModel";
import { applyConstraints, structuralDisagreement } from "./constraints";
import { bridgeGap, linearBridge } from "./gaps";
import { findJumps, repairJump } from "./jumps";
import { ReacquisitionTracker, supportFromDisagreement } from "./reacquisition";
import { smoothTrack } from "./smoothing";
import { findGaps, type Track, type TrackSample } from "./tracks";

const swing = generateSyntheticSwing();

const trackFrom = (
  positions: readonly (Vec3 | null)[],
  visibility = 0.9
): Track => ({
  joint: "leftWrist",
  samples: positions.map((position): TrackSample | null =>
    position ? { position, visibility } : null
  ),
});

/** The real trail-hand track from the synthetic swing. Genuinely fast. */
const handTrack = (): Track =>
  trackFrom(swing.frames.map((frame) => frame.body.joints.rightHand));

/* --------------------------- jumps -------------------------------- */

test("a downswing is not mistaken for a detection error", () => {
  // The whole point of using the second difference rather than speed. This
  // track reaches well over 20 m/s and must pass through untouched.
  const track = handTrack();
  const { flags, thresholdM } = findJumps(track, { heightM: 1.8 });

  assert.equal(
    flags.size,
    0,
    `flagged ${flags.size} frames of clean fast motion (threshold ${(thresholdM * 1000).toFixed(1)}mm)`
  );

  let peakSpeed = 0;
  for (let i = 1; i < track.samples.length; i += 1) {
    peakSpeed = Math.max(
      peakSpeed,
      distance(track.samples[i]!.position, track.samples[i - 1]!.position) * swing.fps
    );
  }
  assert.ok(peakSpeed > 12, `this track is only reaching ${peakSpeed.toFixed(1)} m/s`);
});

test("an isolated jump is found, and repaired to the midpoint of its neighbours", () => {
  const track = handTrack();
  const victim = 90;
  const truth = track.samples[victim]!.position;
  track.samples[victim] = {
    position: add(truth, [0.25, -0.1, 0.05]),
    visibility: 0.9,
  };

  const { flags } = findJumps(track, { heightM: 1.8 });
  assert.ok(flags.has(victim), "the injected jump was not found");
  assert.equal(flags.size, 1, "something other than the jump was flagged too");

  const repaired = repairJump(track, victim);
  assert.ok(repaired);
  assert.ok(
    distance(repaired, truth) < distance(track.samples[victim]!.position, truth),
    "the repair should be closer to the truth than the jump was"
  );
});

test("a track with almost nothing in it flags nothing", () => {
  // Guessing a scale from three samples would mean flagging or excusing on no
  // evidence at all.
  const track = trackFrom([
    [0, 0, 0],
    [0, 1, 0],
    [5, 0, 0],
  ]);
  assert.equal(findJumps(track).flags.size, 0);
});

/* ---------------------------- gaps -------------------------------- */

test("a bridge uses both sides, and beats a straight line on a curved path", () => {
  const track = handTrack();
  const start = 84;
  const length = 9;

  const truth = track.samples
    .slice(start, start + length)
    .map((sample) => sample!.position);
  for (let i = start; i < start + length; i += 1) track.samples[i] = null;

  const gaps = findGaps(track);
  const gap = gaps.find((entry) => entry.start === start);
  assert.ok(gap, "the gap was not found");
  assert.equal(gap.length, length);
  assert.equal(gap.before, start - 1);
  assert.equal(gap.after, start + length);

  const bridged = bridgeGap(track, gap);
  assert.equal(bridged.kind, "bridged");

  const linear = linearBridge(track, gap);
  const meanError = (points: readonly { position: Vec3 }[]) =>
    points.reduce((sum, point, i) => sum + distance(point.position, truth[i]), 0) /
    points.length;

  const bridgedError = meanError(bridged.points);
  const linearError = meanError(linear);

  assert.ok(
    bridgedError < linearError,
    `the bridge (${(bridgedError * 1000).toFixed(0)}mm) should beat a straight line ` +
      `(${(linearError * 1000).toFixed(0)}mm) across a curved path`
  );

  // Judged against how far the joint actually travelled, not against a fixed
  // number of millimetres. This gap spans the downswing, where the hand covers
  // more than a metre in nine frames -- an absolute threshold there would
  // either be trivially loose for a slow gap or impossible for a fast one.
  const travelled = distance(
    track.samples[gap.before!]!.position,
    track.samples[gap.after!]!.position
  );
  assert.ok(
    bridgedError < travelled * 0.2,
    `bridge error ${(bridgedError * 1000).toFixed(0)}mm over ${(travelled * 1000).toFixed(0)}mm travelled`
  );
});

test("endpoint velocities are trusted less as the gap grows", () => {
  // A velocity measured at the edge says a lot about the next two frames and
  // very little about the next forty. Trusting it over a long gap produces a
  // confident, elaborate, invented journey.
  const track = handTrack();
  const shortGap = { start: 50, end: 52, length: 3, before: 49, after: 53 };
  const longGap = { start: 50, end: 89, length: 40, before: 49, after: 90 };

  const short = bridgeGap(track, shortGap).tangentWeight;
  const long = bridgeGap(track, longGap).tangentWeight;

  assert.ok(short > 0.8, `a three-frame gap should nearly trust its velocities, got ${short.toFixed(2)}`);
  assert.ok(long < 0.45, `a forty-frame gap should not, got ${long.toFixed(2)}`);
  assert.ok(short > long * 2, "the weighting should fall substantially with gap length");
});

test("a gap with only one side is held, not flung along the last velocity", () => {
  const track = handTrack();
  for (let i = 100; i < track.samples.length; i += 1) track.samples[i] = null;

  const gap = findGaps(track).find((entry) => entry.start === 100);
  assert.ok(gap);
  assert.equal(gap.after, null);

  const result = bridgeGap(track, gap);
  assert.equal(result.kind, "extrapolated");

  const anchor = track.samples[99]!.position;
  for (const point of result.points) {
    assert.deepEqual(point.position, anchor, "an extrapolated joint should hold still");
  }
});

test("a gap with no evidence at either end says nothing", () => {
  const track = trackFrom([null, null, null]);
  const gap = findGaps(track)[0];
  const result = bridgeGap(track, gap);
  assert.equal(result.kind, "unbridged");
  assert.equal(result.points.length, 0);
});

/* -------------------------- smoothing ------------------------------ */

test("smoothing leaves constant acceleration exactly alone", () => {
  // This is the property that makes "do not smooth because it looks ugly"
  // achievable. A moving average would flatten this by construction; a
  // quadratic fit reproduces it exactly, so a real downswing survives.
  const a: Vec3 = [3, -9.81, 1.5];
  const v: Vec3 = [12, 4, -2];
  const dt = 1 / 60;
  const positions: Vec3[] = [];
  for (let i = 0; i < 40; i += 1) {
    const t = i * dt;
    positions.push(add(scale(v, t), scale(a, 0.5 * t * t)));
  }

  const result = smoothTrack({
    positions,
    trust: positions.map(() => 0.9),
    // Full strength: even asked to smooth as hard as it can, it must not
    // change a quadratic.
    strength: positions.map(() => 1),
  });

  const worst = Math.max(...result.correctionM);
  assert.ok(worst < 1e-6, `smoothing moved a constant-acceleration path by ${worst}m`);
});

test("smoothing pulls noise toward the underlying motion", () => {
  const dt = 1 / 60;
  const clean: Vec3[] = [];
  for (let i = 0; i < 40; i += 1) {
    const t = i * dt;
    clean.push([2 * t, 0.5 * t * t, 0]);
  }
  // Deterministic alternating noise, so the test cannot flake.
  const noisy = clean.map((point, i): Vec3 => [
    point[0] + (i % 2 === 0 ? 0.01 : -0.01),
    point[1] + (i % 3 === 0 ? 0.012 : -0.008),
    point[2],
  ]);

  const result = smoothTrack({
    positions: noisy,
    trust: noisy.map(() => 0.4),
    strength: noisy.map(() => 0.8),
  });

  const errorOf = (points: readonly Vec3[]) =>
    points.reduce((sum, point, i) => sum + distance(point, clean[i]), 0) / points.length;

  assert.ok(
    errorOf(result.positions) < errorOf(noisy) * 0.8,
    `smoothing should have cut the error: ${errorOf(noisy).toFixed(5)} -> ${errorOf(result.positions).toFixed(5)}`
  );
});

test("a sample with zero strength is returned untouched", () => {
  const positions: Vec3[] = Array.from({ length: 10 }, (_v, i) => [i, i * i, 0]);
  const result = smoothTrack({
    positions,
    trust: positions.map(() => 1),
    strength: positions.map(() => 0),
  });
  assert.deepEqual(result.positions, positions);
  assert.ok(result.correctionM.every((value) => value === 0));
});

/* ------------------------- constraints ----------------------------- */

const modelFromSwing = () => {
  const tracks = {} as Parameters<typeof measureBodyModel>[0];
  for (const joint of Object.keys(swing.frames[0].body.joints) as (keyof typeof swing.frames[0]["body"]["joints"])[]) {
    tracks[joint] = {
      joint,
      samples: swing.frames.map((frame) => ({
        position: frame.body.joints[joint],
        visibility: 0.95,
      })),
    };
  }
  return measureBodyModel(tracks, swing.frames.length);
};

test("the body model measures this golfer's bones, tightly", () => {
  const model = modelFromSwing();
  const femur = model.bones["leftHip~leftKnee"];
  const trueFemur = distance(
    swing.frames[0].body.joints.leftHip,
    swing.frames[0].body.joints.leftKnee
  );

  assert.ok(Math.abs(femur.lengthM - trueFemur) < 0.003);
  assert.ok(femur.confidence > 0.9, `femur confidence was ${femur.confidence.toFixed(2)}`);
  assert.ok(femur.spreadM < 0.005, "a rigid bone measured from clean data should barely vary");
});

test("a stretched bone is pulled back, and the less-trusted end does the moving", () => {
  const model = modelFromSwing();
  const joints = { ...swing.frames[60].body.joints };
  const target = model.bones["leftHip~leftKnee"].lengthM;

  /*
   * Stretch the femur ALONG its own axis.
   *
   * Displacing the knee sideways barely lengthens the bone -- 150mm
   * perpendicular to a 441mm femur stretches it by 7mm, which is inside
   * tolerance and correctly not a violation. Testing the solver needs a real
   * stretch, not a real displacement.
   */
  const before = joints.leftKnee;
  const axis = scale(normalise(sub(before, joints.leftHip)), 0.15);
  joints.leftKnee = add(before, axis);

  const trust = Object.fromEntries(
    Object.keys(joints).map((joint) => [joint, 0.9])
  ) as Record<keyof typeof joints, number>;
  trust.leftKnee = 0.1; // the knee is the doubtful one

  const solved = applyConstraints({ joints, trust, model });

  const after = distance(solved.joints.leftHip, solved.joints.leftKnee);
  assert.ok(
    Math.abs(after - target) < target * 0.03,
    `femur is still ${after.toFixed(3)}m against a target of ${target.toFixed(3)}m`
  );
  assert.ok(
    solved.correctionM.leftKnee > solved.correctionM.leftHip * 3,
    `the doubtful knee should absorb the correction: knee ${solved.correctionM.leftKnee.toFixed(4)}, hip ${solved.correctionM.leftHip.toFixed(4)}`
  );
  assert.ok(solved.violations.has("leftHip~leftKnee"));
});

test("a clean pose is left alone", () => {
  const model = modelFromSwing();
  const joints = { ...swing.frames[60].body.joints };
  const trust = Object.fromEntries(
    Object.keys(joints).map((joint) => [joint, 0.9])
  ) as Record<keyof typeof joints, number>;

  const solved = applyConstraints({ joints, trust, model });
  const worst = Math.max(...Object.values(solved.correctionM));
  assert.ok(worst < 0.002, `the solver moved a valid pose by ${(worst * 1000).toFixed(1)}mm`);
  assert.equal(solved.violations.size, 0);
});

test("structural disagreement tells a plausible return from an impossible one", () => {
  const model = modelFromSwing();
  const joints = swing.frames[60].body.joints;
  const trust = Object.fromEntries(
    Object.keys(joints).map((joint) => [joint, 0.9])
  ) as Record<keyof typeof joints, number>;

  const truthful = structuralDisagreement("leftKnee", joints.leftKnee, joints, trust, model);
  const impossible = structuralDisagreement(
    "leftKnee",
    add(joints.leftKnee, [0.3, 0.2, 0]),
    joints,
    trust,
    model
  );

  assert.ok(truthful.neighboursUsed >= 2, "the knee should have connected evidence");
  assert.ok(truthful.disagreementM < 0.01);
  assert.ok(
    impossible.disagreementM > truthful.disagreementM * 10,
    "a displaced knee should visibly break its bones"
  );

  assert.ok(supportFromDisagreement(truthful.disagreementM, truthful.neighboursUsed) > 0.9);
  assert.ok(
    supportFromDisagreement(impossible.disagreementM, impossible.neighboursUsed) < 0.3
  );
});

/* ------------------------ reacquisition ---------------------------- */

test("a return close to the prediction is simply reattached", () => {
  const tracker = new ReacquisitionTracker({ heightM: 1.8 });
  const judgement = tracker.judge("leftHip", [0.011, 1, 0], [0, 1, 0], 0.9);
  assert.equal(judgement.verdict, "confirmed");
  assert.equal(judgement.blend, 1);
});

test("a moderate disagreement reconciles gradually rather than snapping", () => {
  const tracker = new ReacquisitionTracker({ heightM: 1.8 });
  const judgement = tracker.judge("leftHip", [0.09, 1, 0], [0, 1, 0], 0.6);
  assert.equal(judgement.verdict, "reconcile");
  assert.ok(judgement.blend > 0 && judgement.blend < 0.6, "it must not snap");
});

test("a wild return is doubted, then earns its place by repeating", () => {
  // The plan's third case: require consistent evidence across subsequent
  // frames before letting it substantially move the model.
  const tracker = new ReacquisitionTracker({ heightM: 1.8, agreementFramesRequired: 4 });
  const wild: Vec3 = [0.8, 1, 0];
  const predicted: Vec3 = [0, 1, 0];

  const first = tracker.judge("leftHip", wild, predicted, 0.1);
  assert.equal(first.verdict, "doubted");
  assert.ok(first.blend < 0.05, "a wild return should barely move the model at first");

  let last = first;
  for (let i = 0; i < 3; i += 1) {
    last = tracker.judge("leftHip", wild, predicted, 0.1);
  }
  assert.equal(last.agreementFrames, 4);
  assert.equal(last.verdict, "reconcile", "consistent evidence should eventually be accepted");
  assert.ok(last.blend > first.blend * 3);
});

test("a flickering return never accumulates agreement", () => {
  const tracker = new ReacquisitionTracker({ heightM: 1.8, agreementFramesRequired: 4 });
  const predicted: Vec3 = [0, 1, 0];
  for (let i = 0; i < 8; i += 1) {
    // Somewhere different every frame: a detector flickering, not a body.
    const judgement = tracker.judge("leftHip", [0.8 + i * 0.12, 1, 0], predicted, 0.1);
    assert.equal(judgement.verdict, "doubted");
    assert.equal(judgement.agreementFrames, 1);
  }
});

test("connected structures widen what counts as a plausible return", () => {
  // The plan's rule: if the body supports the returning position, it should
  // be believed sooner, even though it is far from a prediction that may
  // itself have drifted.
  const supported = new ReacquisitionTracker({ heightM: 1.8 }).judge(
    "leftHip",
    [0.15, 1, 0],
    [0, 1, 0],
    1
  );
  const contradicted = new ReacquisitionTracker({ heightM: 1.8 }).judge(
    "leftHip",
    [0.15, 1, 0],
    [0, 1, 0],
    0
  );

  assert.equal(supported.verdict, "reconcile");
  assert.equal(contradicted.verdict, "doubted");
});

test("losing a joint clears its probation", () => {
  const tracker = new ReacquisitionTracker({ heightM: 1.8, agreementFramesRequired: 3 });
  const wild: Vec3 = [0.8, 1, 0];
  tracker.judge("leftHip", wild, [0, 1, 0], 0.1);
  tracker.judge("leftHip", wild, [0, 1, 0], 0.1);
  tracker.forget("leftHip");
  const after = tracker.judge("leftHip", wild, [0, 1, 0], 0.1);
  assert.equal(after.agreementFrames, 1, "evidence should not survive the joint vanishing");
});
