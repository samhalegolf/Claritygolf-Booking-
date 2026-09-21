import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLARITY_JOINTS,
  RIGID_BONES,
  boneKey,
  distance,
  length,
  normalise,
  qRotate,
  sub,
  type ClarityJoint,
} from "../contracts";
import { generateSyntheticSwing } from "./syntheticSwing";
import { RIGHT_HANDED_IMPACT_SECONDS, sampleSwing, RIGHT_HANDED_SWING } from "./swingKeyframes";

const swing = generateSyntheticSwing();

test("the sequence covers the schedule at the requested rate", () => {
  assert.equal(swing.fps, 60);
  // 2.4s at 60fps.
  assert.equal(swing.frames.length, 144);
  assert.equal(swing.frames[0].index, 0);
  assert.ok(Math.abs(swing.frames[0].timestampMs) < 1e-9);
  assert.ok(Math.abs(swing.frames[143].timestampMs - 2383.33) < 1, "last frame lands near 2.38s");
});

test("no joint is ever NaN", () => {
  // One NaN anywhere propagates silently into the mass centre, the camera
  // framing and the trail geometry, and shows up as an empty 3D view with no
  // error. Cheap to check, expensive to debug.
  for (const frame of swing.frames) {
    for (const joint of CLARITY_JOINTS) {
      const position = frame.body.joints[joint];
      assert.ok(
        Number.isFinite(position[0] + position[1] + position[2]),
        `frame ${frame.index} joint ${joint} is not finite: ${JSON.stringify(position)}`
      );
    }
  }
});

test("rigid bones keep their length for the whole swing", () => {
  // "A femur does not suddenly change length" is a constraint the real Motion
  // Layer will enforce. The fixture has to satisfy it already, or the solver
  // would be graded against data that breaks its own rule.
  const model = swing.bodyModel;
  for (const bone of RIGID_BONES) {
    const expected = model.boneLengths[boneKey(bone)];
    assert.ok(expected > 0, `${boneKey(bone)} has no measured length`);

    let worst = 0;
    let worstFrame = -1;
    for (const frame of swing.frames) {
      const actual = distance(frame.body.joints[bone.from], frame.body.joints[bone.to]);
      const drift = Math.abs(actual - expected);
      if (drift > worst) {
        worst = drift;
        worstFrame = frame.index;
      }
    }
    assert.ok(
      worst < 0.002,
      `${boneKey(bone)} drifted ${(worst * 1000).toFixed(1)}mm at frame ${worstFrame} ` +
        `(expected ${expected.toFixed(4)}m)`
    );
  }
});

test("the club keeps its length and stays attached to the hands", () => {
  // A club that stretches or detaches is the plan's named debugging signal.
  // In clean synthetic data it must do neither, so that when it DOES happen
  // with real input the signal means something.
  for (const frame of swing.frames) {
    const club = frame.club;
    assert.ok(club, `frame ${frame.index} has no club`);

    const shaftLength = distance(club.grip, club.head);
    assert.ok(
      Math.abs(shaftLength - club.lengthM) < 0.06,
      `frame ${frame.index}: shaft measured ${shaftLength.toFixed(3)}m, declared ${club.lengthM}m`
    );

    const handsCentre: [number, number, number] = [
      (frame.body.joints.leftHand[0] + frame.body.joints.rightHand[0]) / 2,
      (frame.body.joints.leftHand[1] + frame.body.joints.rightHand[1]) / 2,
      (frame.body.joints.leftHand[2] + frame.body.joints.rightHand[2]) / 2,
    ];
    assert.ok(
      distance(club.grip, handsCentre) < 0.14,
      `frame ${frame.index}: grip is ${distance(club.grip, handsCentre).toFixed(3)}m from the hands`
    );
  }
});

test("the CBP lies on the shaft, between grip and head", () => {
  // The balance point is DERIVED from club geometry rather than detected, so
  // it must be collinear with the shaft by construction. A CBP that drifts
  // off the shaft means the derivation has stopped using the geometry.
  for (const frame of swing.frames) {
    const club = frame.club!;
    const shaft = sub(club.head, club.grip);
    const toCbp = sub(club.cbp, club.grip);
    const shaftLength = length(shaft);

    const along = (toCbp[0] * shaft[0] + toCbp[1] * shaft[1] + toCbp[2] * shaft[2]) / shaftLength;
    const perpendicular = Math.sqrt(Math.max(0, length(toCbp) ** 2 - along ** 2));

    assert.ok(perpendicular < 1e-6, `frame ${frame.index}: CBP is ${perpendicular}m off the shaft`);
    assert.ok(
      along > 0 && along < shaftLength,
      `frame ${frame.index}: CBP sits outside the shaft at ${along.toFixed(3)} of ${shaftLength.toFixed(3)}`
    );
  }
});

test("the arms are never asked to reach further than they can", () => {
  // If the swing plane were tilted past the chain's reach, the IK would
  // straighten every frame and the clubhead would silently detach. The plane
  // builder clamps for exactly this; this test proves the clamp works.
  for (const frame of swing.frames) {
    const club = frame.club!;
    const shoulderMid: [number, number, number] = [
      (frame.body.joints.leftShoulder[0] + frame.body.joints.rightShoulder[0]) / 2,
      (frame.body.joints.leftShoulder[1] + frame.body.joints.rightShoulder[1]) / 2,
      (frame.body.joints.leftShoulder[2] + frame.body.joints.rightShoulder[2]) / 2,
    ];
    const reach = distance(shoulderMid, club.head);
    assert.ok(reach < 1.75, `frame ${frame.index}: hub-to-clubhead is ${reach.toFixed(3)}m`);
  }
});

test("the clubhead reaches the ground around address and impact", () => {
  const addressFrame = swing.frames[Math.round(0.2 * swing.fps)];
  const impactFrame = swing.frames[Math.round(RIGHT_HANDED_IMPACT_SECONDS * swing.fps)];

  assert.ok(
    Math.abs(addressFrame.club!.head[1]) < 0.09,
    `at address the clubhead sits at Y=${addressFrame.club!.head[1].toFixed(3)}`
  );
  assert.ok(
    Math.abs(impactFrame.club!.head[1]) < 0.12,
    `at impact the clubhead sits at Y=${impactFrame.club!.head[1].toFixed(3)}`
  );
});

test("the top of the backswing puts the clubhead high and behind", () => {
  const topFrame = swing.frames[Math.round(1.22 * swing.fps)];
  const head = topFrame.club!.head;
  assert.ok(head[1] > 1.4, `clubhead at the top is only ${head[1].toFixed(2)}m up`);
  assert.ok(head[0] > 0.2, `clubhead at the top should be on the trail side, got X=${head[0].toFixed(2)}`);
});

test("the schedule's separation peaks after the top, not at it", () => {
  // The pelvis reverses while the thorax is still going back. If that ever
  // stopped being true the fixture would stop exercising the case where two
  // connected structures disagree about direction -- which is precisely the
  // case the reacquisition logic has to handle.
  const separationAt = (t: number) => {
    const key = sampleSwing(RIGHT_HANDED_SWING, t);
    return key.thoraxYaw - key.pelvisYaw;
  };
  assert.ok(
    separationAt(1.3) > separationAt(1.22),
    "separation should still be growing just after the top"
  );
});

test("feet stay planted and the trail heel lifts through the finish", () => {
  const addressFrame = swing.frames[0];
  assert.ok(Math.abs(addressFrame.body.joints.leftHeel[1]) < 1e-9, "lead heel starts down");
  assert.ok(Math.abs(addressFrame.body.joints.rightHeel[1]) < 1e-9, "trail heel starts down");

  const finishFrame = swing.frames[swing.frames.length - 1];
  assert.ok(
    finishFrame.body.joints.rightHeel[1] > 0.2,
    `trail heel should be high at the finish, got ${finishFrame.body.joints.rightHeel[1].toFixed(3)}`
  );
  assert.ok(
    Math.abs(finishFrame.body.joints.rightToe[1]) < 1e-9,
    "the trail toe stays on the ground"
  );
});

test("support moves onto the lead foot through the swing", () => {
  const address = swing.frames[0].mass!;
  const finish = swing.frames[swing.frames.length - 1].mass!;

  assert.ok(Math.abs(address.footShare.left - 0.5) < 0.12, "address is roughly balanced");
  assert.ok(
    finish.footShare.left > 0.62,
    `the finish should be on the lead foot, got L=${finish.footShare.left.toFixed(2)}`
  );
  // The trail heel is up at the finish, so its heel has left the polygon.
  assert.ok(
    finish.supportPolygon.length >= 2,
    "some foot geometry remains in contact at the finish"
  );
});

test("clean synthetic data reports near-perfect confidence", () => {
  // The score measures how much reconstruction was needed. Nothing was
  // reconstructed here, so it must be high -- regardless of the fact that the
  // motion is fast and unusual in places.
  for (const frame of swing.frames) {
    assert.equal(frame.provenance.observedFraction, 1);
    assert.equal(frame.provenance.wholeFrameReconstructed, false);
    assert.ok(
      frame.confidence.overall > 0.9,
      `frame ${frame.index} scored ${frame.confidence.overall.toFixed(3)} on clean data`
    );
  }
  assert.ok(swing.confidence.overall > 0.9);
  assert.equal(swing.confidence.largestGapFrames, 0);
  assert.equal(swing.confidence.reconstructedFrameFraction, 0);
});

test("the fastest motion is in the downswing, and it is genuinely fast", () => {
  /*
   * Smoothing and jump rejection must not be tested against data with nothing
   * fast in it.
   *
   * The threshold is 20 m/s rather than a tour-like 45. The schedule models a
   * moderate swing, and the honest number is the one the schedule actually
   * produces -- an earlier version read higher only because per-segment
   * smootherstep made the motion stop and restart at every keyframe, which
   * inflated the peaks with acceleration no arm could produce.
   */
  let peakSpeed = 0;
  let peakFrame = -1;
  for (let i = 1; i < swing.frames.length; i += 1) {
    const previous = swing.frames[i - 1].club!.head;
    const current = swing.frames[i].club!.head;
    const speed = distance(previous, current) * swing.fps;
    if (speed > peakSpeed) {
      peakSpeed = speed;
      peakFrame = i;
    }
  }
  assert.ok(peakSpeed > 20, `peak clubhead speed is only ${peakSpeed.toFixed(1)} m/s`);
  const peakTime = peakFrame / swing.fps;
  assert.ok(
    peakTime > 1.3 && peakTime < 1.7,
    `peak speed should be in the downswing, landed at ${peakTime.toFixed(2)}s`
  );
});

test("the same seed produces the same swing", () => {
  const a = generateSyntheticSwing({ seed: 7, degradation: { noiseM: 0.01 } });
  const b = generateSyntheticSwing({ seed: 7, degradation: { noiseM: 0.01 } });
  assert.deepEqual(a.frames[40].body.joints, b.frames[40].body.joints);

  const c = generateSyntheticSwing({ seed: 8, degradation: { noiseM: 0.01 } });
  assert.notDeepEqual(a.frames[40].body.joints, c.frames[40].body.joints);
});

test("dropouts show as reconstructed provenance and drag the score down", () => {
  const degraded = generateSyntheticSwing({
    degradation: {
      dropouts: [{ joint: "leftHip", startFrame: 50, length: 12 }],
    },
  });

  const during = degraded.frames[55];
  const hip = during.provenance.joints.leftHip;
  assert.equal(hip.source, "reconstructed");
  assert.equal(hip.gapLength, 12);
  assert.equal(hip.framesSinceObserved, 6);
  assert.equal(hip.rawConfidence, 0);
  assert.ok(during.provenance.observedFraction < 1);

  const clean = degraded.frames[10];
  assert.equal(clean.provenance.joints.leftHip.source, "observed");
  assert.ok(
    during.confidence.overall < clean.confidence.overall,
    "a dropout must lower the score"
  );
  assert.equal(degraded.confidence.largestGapFrames, 12);
});

test("an injected jump is reported as a correction, and truth is preserved", () => {
  const degraded = generateSyntheticSwing({
    degradation: { jumps: [{ joint: "rightWrist", frame: 70, offsetM: 0.3 }] },
  });

  const jumped = degraded.frames[70];
  assert.equal(jumped.provenance.joints.rightWrist.source, "constrained");
  assert.ok(Math.abs(jumped.provenance.joints.rightWrist.correctionM - 0.3) < 1e-9);
  assert.ok(jumped.confidence.components.jumpCorrection < 0.2);

  // Ground truth is untouched, so a reconstruction can be graded against it.
  const truthPosition = degraded.truth[70].rightWrist;
  const reportedPosition = jumped.body.joints.rightWrist;
  assert.ok(
    distance(truthPosition, reportedPosition) > 0.25,
    "the reported position should carry the jump"
  );
});

test("losing club evidence decays CBP confidence without touching the body score", () => {
  const degraded = generateSyntheticSwing({ degradation: { clubLostFromFrame: 80 } });

  const before = degraded.frames[79];
  const justAfter = degraded.frames[82];
  const wellAfter = degraded.frames[110];

  assert.equal(before.club!.evidence.headObserved, true);
  assert.equal(justAfter.club!.evidence.headObserved, false);
  assert.ok(justAfter.club!.confidence < before.club!.confidence);
  assert.ok(
    wellAfter.club!.confidence < justAfter.club!.confidence,
    "confidence keeps falling while the head stays unseen"
  );
  assert.ok(wellAfter.club!.confidence < 0.05, "club movement is not invented indefinitely");

  // The plan's rule: a poor club track must not invalidate a good body track.
  assert.ok(
    wellAfter.confidence.overall > 0.9,
    `the body score fell to ${wellAfter.confidence.overall.toFixed(3)} because the club was lost`
  );
  assert.ok(wellAfter.confidence.structures.club < 0.05);
  assert.ok(wellAfter.confidence.structures.thorax > 0.8);
});

test("a taller golfer scales, rather than being the same body moved further", () => {
  const tall = generateSyntheticSwing({ heightM: 2.0 });
  const short = generateSyntheticSwing({ heightM: 1.6 });

  assert.ok(tall.bodyModel.estimatedHeightM > short.bodyModel.estimatedHeightM);
  const tallFemur = tall.bodyModel.boneLengths["leftHip~leftKnee"];
  const shortFemur = short.bodyModel.boneLengths["leftHip~leftKnee"];
  assert.ok(tallFemur > shortFemur * 1.2, "the femur should scale with height");
  assert.ok(tall.anchor.stanceWidthM > short.anchor.stanceWidthM);
});

test("every joint name in the contract is populated", () => {
  const frame = swing.frames[60];
  const populated = Object.keys(frame.body.joints) as ClarityJoint[];
  assert.equal(populated.length, CLARITY_JOINTS.length);
  for (const joint of CLARITY_JOINTS) {
    assert.ok(populated.includes(joint), `${joint} is missing from the pose`);
    assert.ok(frame.provenance.joints[joint], `${joint} is missing provenance`);
  }
});

test("the torso turns about its spine, rather than tipping and swinging round", () => {
  // The bug this pins: composing the turn about world Y and THEN leaning
  // forward makes the lean direction rotate with the turn, so at the top of
  // the backswing the torso appears to have fallen sideways. It looks like a
  // tracking fault and is a modelling one.
  //
  // The spine must keep leaning FORWARD -- toward +Z, over the ball -- at
  // every point in the swing, however far the shoulders have turned.
  for (const frame of swing.frames) {
    const spineUp = qRotate(frame.body.thorax.orientation, [0, 1, 0]);

    assert.ok(
      spineUp[1] > 0.7,
      `frame ${frame.index}: the spine should stay mostly upright, got Y=${spineUp[1].toFixed(3)}`
    );

    // Side bend is scheduled up to -14 degrees, so a little lateral component
    // is expected. A turn leaking into the lean would be far larger than this.
    assert.ok(
      Math.abs(spineUp[0]) < 0.3,
      `frame ${frame.index}: the spine has fallen sideways, X=${spineUp[0].toFixed(3)}`
    );
  }

  // At the top the shoulders have turned nearly square to the camera, which
  // is the thing the forward lean must not be confused with.
  const top = swing.frames[Math.round(1.22 * swing.fps)];
  const shoulderAxis = normalise(
    sub(top.body.joints.rightShoulder, top.body.joints.leftShoulder)
  );
  assert.ok(
    Math.abs(shoulderAxis[2]) > 0.75,
    `at the top the shoulder line should point away from the camera, got Z=${shoulderAxis[2].toFixed(3)}`
  );
});

test("address posture leans forward over the ball", () => {
  const address = swing.frames[0];
  const spineUp = qRotate(address.body.thorax.orientation, [0, 1, 0]);
  /*
   * Leaning FORWARD tips the spine's up-axis toward the toes, and a golfer's
   * toes point along -Z (see `contracts/units`), so this is negative. It
   * used to be positive, back when the fixture was a mirror image of a human.
   */
  assert.ok(
    spineUp[2] < -0.4,
    `address should lean forward over the ball, toward the toes on -Z; got Z=${spineUp[2].toFixed(3)}`
  );
  assert.ok(
    Math.abs(spineUp[0]) < 1e-6,
    "with no side bend scheduled, address should have no lateral lean"
  );
});
