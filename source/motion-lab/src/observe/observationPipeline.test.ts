/**
 * The observation pipeline, end to end.
 *
 * A known body -> the detector's convention -> the real mapping and anchoring
 * -> back to Clarity world space. If what comes out is not what went in, one
 * of the axis conversions is wrong.
 *
 * This matters more than it looks. A mirrored reconstruction does not throw
 * and does not look broken -- it looks like a left-handed golfer. Without a
 * round trip against known truth, that survives to production.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type ClarityJoint, type Vec3 } from "../contracts";
import { generateSyntheticSwing } from "../synthetic/syntheticSwing";
import { anchorSequence, detectionRate, findAnchorFrame } from "./anchor";
import type { CameraObservationSequence, ObservationFrame, RawLandmark } from "./observation";
import { estimateMass } from "../motion/mass/massModel";
import { MP } from "./mediapipe/landmarks";
import { detectFromClarityFrames } from "./syntheticDetector";
import { observedFraction, toCameraFrame, toClarityAxes } from "./toCameraFrame";

const swing = generateSyntheticSwing();

const buildCameraSequence = (
  raw: readonly ObservationFrame[]
): CameraObservationSequence => ({
  space: "camera",
  frames: raw.map((frame) => toCameraFrame(frame)),
  fps: swing.fps,
  width: 1920,
  height: 1080,
  durationMs: swing.frames.length * (1000 / swing.fps),
  detector: "synthetic",
});

const runPipeline = (options: Parameters<typeof detectFromClarityFrames>[1] = {}) =>
  anchorSequence(buildCameraSequence(detectFromClarityFrames(swing.frames, options)));

/* ------------------------- the axis conversion ------------------------- */

test("toClarityAxes flips Y and Z, and keeps the frame right-handed", () => {
  const point: RawLandmark = { x: 0.3, y: 0.7, z: 0.2, visibility: 1, presence: 1 };
  assert.deepEqual(toClarityAxes(point), [0.3, -0.7, -0.2]);

  // Handedness is the thing that matters. MediaPipe's basis is (right, down,
  // into-screen), which is right-handed; ours must be too. Negating Y alone
  // would mirror the golfer -- and a mirrored swing still looks like a swing.
  const right = toClarityAxes({ x: 1, y: 0, z: 0, visibility: 1, presence: 1 });
  const down = toClarityAxes({ x: 0, y: 1, z: 0, visibility: 1, presence: 1 });
  const into = toClarityAxes({ x: 0, y: 0, z: 1, visibility: 1, presence: 1 });

  // right x up should be toward the camera, which is where -into landed.
  const up: Vec3 = [-down[0], -down[1], -down[2]];
  const cross: Vec3 = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];
  const towardCamera: Vec3 = [-into[0], -into[1], -into[2]];
  assert.ok(
    distance(cross, towardCamera) < 1e-9,
    `right x up should point toward the camera: got ${cross}, wanted ${towardCamera}`
  );
});

/* ---------------------------- the mapping ------------------------------ */

test("a joint is dropped when any landmark it is built from is missing", () => {
  // A midpoint built from one good landmark and one missing one is not a
  // midpoint; it sits half a head-width from the truth and reports itself as
  // observed. Better to have no head than a confidently wrong one.
  const [raw] = detectFromClarityFrames([swing.frames[0]]);
  const world = [...(raw.world ?? [])];
  world[7] = { x: 0, y: 0, z: 0, visibility: 0, presence: 0 }; // left ear

  const frame = toCameraFrame({ ...raw, world });
  assert.equal(frame.joints.head, undefined, "head should be absent, not approximated");
  assert.ok(frame.joints.neck, "the neck is built from other landmarks and survives");
});

test("an undetected frame yields no joints at all", () => {
  const [raw] = detectFromClarityFrames([swing.frames[0]], { blindFrames: [0] });
  const frame = toCameraFrame(raw);
  assert.equal(frame.detected, false);
  assert.equal(Object.keys(frame.joints).length, 0);
  assert.equal(observedFraction(frame), 0);
});

test("low visibility is dropped, not silently trusted", () => {
  const [raw] = detectFromClarityFrames([swing.frames[0]]);
  const world = (raw.world ?? []).map((entry) => ({ ...entry, visibility: 0.05 }));
  const frame = toCameraFrame({ ...raw, world });
  assert.equal(Object.keys(frame.joints).length, 0);

  // The floor is configurable, and a permissive floor keeps the evidence.
  const permissive = toCameraFrame({ ...raw, world }, { visibilityFloor: 0, presenceFloor: 0 });
  assert.ok(Object.keys(permissive.joints).length > 15);
});

test("derived joints record how many landmarks they came from", () => {
  const [raw] = detectFromClarityFrames([swing.frames[0]]);
  const frame = toCameraFrame(raw);
  assert.equal(frame.joints.leftShoulder?.sourceCount, 1);
  assert.equal(frame.joints.head?.sourceCount, 2, "the head is the midpoint of the ears");
  assert.equal(frame.joints.neck?.sourceCount, 2);
  assert.equal(frame.joints.leftHand?.sourceCount, 2);
});

/* --------------------------- the round trip ---------------------------- */

test("a body survives the round trip through the detector's convention", () => {
  const anchored = runPipeline();

  let worst = 0;
  let worstJoint: ClarityJoint | null = null;
  let worstFrame = -1;

  for (const frame of anchored.frames) {
    const truth = swing.frames[frame.index].body.joints;
    for (const joint of CLARITY_JOINTS) {
      const observed = frame.joints[joint];
      if (!observed) continue;
      const error = distance(observed.position as Vec3, truth[joint]);
      if (error > worst) {
        worst = error;
        worstJoint = joint;
        worstFrame = frame.index;
      }
    }
  }

  assert.ok(
    worst < 0.01,
    `worst round-trip error was ${(worst * 1000).toFixed(1)}mm at ${worstJoint} on frame ${worstFrame}`
  );
});

test("the round trip survives the golfer standing at an angle to the camera", () => {
  // With no camera yaw the anchoring rotation is the identity, so a broken
  // rotation would pass unnoticed. Standing the golfer at 37 degrees makes
  // the rotation do real work.
  const anchored = runPipeline({ cameraYawDeg: 37 });

  let worst = 0;
  for (const frame of anchored.frames) {
    const truth = swing.frames[frame.index].body.joints;
    for (const joint of CLARITY_JOINTS) {
      const observed = frame.joints[joint];
      if (!observed) continue;
      worst = Math.max(worst, distance(observed.position as Vec3, truth[joint]));
    }
  }
  assert.ok(worst < 0.01, `yawed round-trip error was ${(worst * 1000).toFixed(1)}mm`);
});

test("the golfer is not mirrored: anatomical left stays on the -X side at address", () => {
  const anchored = runPipeline({ cameraYawDeg: 37 });
  const address = anchored.frames[0];

  const left = address.joints.leftAnkle!;
  const right = address.joints.rightAnkle!;
  assert.ok(
    left.position[0] < right.position[0],
    `+X must run from the left foot toward the right foot, got L=${left.position[0].toFixed(3)} R=${right.position[0].toFixed(3)}`
  );

  // And the body is the right way up.
  assert.ok(address.joints.head!.position[1] > address.joints.leftHip!.position[1]);
  assert.ok(address.joints.leftHip!.position[1] > address.joints.leftAnkle!.position[1]);
});

test("the golfer is a possible human: right cross up points BEHIND them", () => {
  /*
   * THE TEST THAT WAS MISSING, AND WHAT IT COST.
   *
   * Checking that the left foot is on -X is not enough, because the anchor
   * DEFINES +X as left-to-right -- it is true by construction and cannot
   * fail. What it never checked was the remaining degree of freedom: which
   * way the toes point relative to that axis.
   *
   * For a real person, right cross up points BEHIND them. The mnemonic is
   * East-North-Up: E cross N is Up, so E cross U is SOUTH. The fixture was
   * built the other way round and `units.ts` documented the same mistake, so
   * the two agreed with each other and 198 tests passed over a mirror image
   * of a human.
   *
   * It surfaced the first time real footage was tried. MediaPipe on a face-on
   * clip put the left ankle at image x 0.595 against the right at 0.398 --
   * correct for a golfer facing the lens -- with the toes toward the camera,
   * giving dot(R x U, toes) = -0.996 where the fixture gave +0.993.
   *
   * The damage was not cosmetic. Every signal whose meaning depends on the
   * fore-aft SIGN came out backwards on real video while looking perfect on
   * the fixture: the direction `hipSetBackM` calls "behind", the sign of
   * `apparentLeanDeg`, and worst, the sign of the camera-pitch correction,
   * which would have doubled the error it was meant to remove.
   */
  const address = runPipeline({ cameraYawDeg: 37 }).frames[0];
  const at = (joint: ClarityJoint) => address.joints[joint]!.position as Vec3;
  const mid = (a: Vec3, b: Vec3): Vec3 => [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  ];

  const right = mid(at("rightHeel"), at("rightToe"));
  const left = mid(at("leftHeel"), at("leftToe"));
  const across: Vec3 = [right[0] - left[0], 0, right[2] - left[2]];
  const up: Vec3 = [0, 1, 0];
  // across x up, ground-projected.
  const behind: Vec3 = [
    across[1] * up[2] - across[2] * up[1],
    0,
    across[0] * up[1] - across[1] * up[0],
  ];

  const toes: Vec3 = [
    mid(at("leftToe"), at("rightToe"))[0] - mid(at("leftHeel"), at("rightHeel"))[0],
    0,
    mid(at("leftToe"), at("rightToe"))[2] - mid(at("leftHeel"), at("rightHeel"))[2],
  ];

  const unit = (v: Vec3): Vec3 => {
    const length = Math.hypot(v[0], v[2]) || 1;
    return [v[0] / length, 0, v[2] / length];
  };
  const a = unit(behind);
  const b = unit(toes);
  const alignment = a[0] * b[0] + a[2] * b[2];

  assert.ok(
    alignment < -0.8,
    `right cross up must point AWAY from the toes for a real human; dot was ${alignment.toFixed(3)} (positive means the body is mirrored)`
  );
});

/* ---------------------------- the anchor ------------------------------- */

test("the anchor lands on the still address hold, not mid-swing", () => {
  const camera = buildCameraSequence(detectFromClarityFrames(swing.frames));
  const choice = findAnchorFrame(camera.frames);

  // Address is held for the first 0.4s, so the anchor should be inside it.
  assert.ok(
    choice.index <= Math.round(0.4 * swing.fps),
    `anchor landed at frame ${choice.index}, outside the address hold`
  );
  assert.equal(choice.stable, true);
});

test("the anchor measures stance width, and it matches the body", () => {
  const anchored = runPipeline();
  const trueWidth = distance(
    swing.frames[0].body.joints.leftAnkle,
    swing.frames[0].body.joints.rightAnkle
  );
  assert.ok(
    Math.abs(anchored.anchor.stanceWidthM - trueWidth) < 0.01,
    `measured ${anchored.anchor.stanceWidthM.toFixed(3)}m against a true ${trueWidth.toFixed(3)}m`
  );
  assert.equal(anchored.anchor.anchorIsStable, true);
});

test("the feet stay on the ground through the whole swing", () => {
  /*
   * Anchoring pins the ground. If a foot floats or sinks, the support model
   * downstream is computing contact against nothing.
   *
   * A tolerance rather than exactness, deliberately. Pinning the lowest foot
   * point to exactly zero EVERY frame would satisfy this to the millimetre
   * and is a worse estimator: a minimum over noisy samples is biased low and
   * jumps to whichever point was measured worst, so the whole body bobs. The
   * ground is instead set once for the clip from a low percentile, which
   * leaves individual frames a few millimetres out and the body still.
   */
  const anchored = runPipeline();
  for (const frame of anchored.frames) {
    const candidates = (["leftHeel", "leftToe", "rightHeel", "rightToe"] as const)
      .map((joint) => frame.joints[joint]?.position[1])
      .filter((value): value is number => value !== undefined);
    if (candidates.length === 0) continue;

    const lowest = Math.min(...candidates);
    assert.ok(
      lowest > -0.02 && lowest < 0.02,
      `frame ${frame.index}: lowest foot point is at Y=${lowest.toFixed(4)}, off the ground`
    );
  }
});

test("a frame with no visible feet carries the previous offset instead of snapping", () => {
  // Losing the feet for a moment must not jolt the whole body. A one-frame
  // jump of the entire skeleton reads as a tracking failure, and would be one
  // the pipeline caused.
  const anchored = runPipeline({
    dropouts: [
      { joint: "leftAnkle", startFrame: 60, length: 6 },
      { joint: "rightAnkle", startFrame: 60, length: 6 },
      { joint: "leftHeel", startFrame: 60, length: 6 },
      { joint: "rightHeel", startFrame: 60, length: 6 },
      { joint: "leftToe", startFrame: 60, length: 6 },
      { joint: "rightToe", startFrame: 60, length: 6 },
    ],
  });

  const before = anchored.frames[59].joints.neck!;
  const during = anchored.frames[60].joints.neck!;
  assert.ok(
    distance(before.position as Vec3, during.position as Vec3) < 0.08,
    "the body jumped when the feet were lost"
  );
});

test("an anchor found without both feet is reported as unstable", () => {
  // The axes cannot be trusted, and the sequence has to say so rather than
  // quietly producing confident nonsense.
  const raw = detectFromClarityFrames(swing.frames, {
    dropouts: [{ joint: "rightAnkle", startFrame: 0, length: swing.frames.length }],
  });
  const anchored = anchorSequence(buildCameraSequence(raw));
  assert.equal(anchored.anchor.anchorIsStable, false);
  assert.equal(anchored.anchor.stanceWidthM, 0);
});

test("detection rate reflects blind frames", () => {
  const camera = buildCameraSequence(
    detectFromClarityFrames(swing.frames, { blindFrames: [10, 11, 12, 13] })
  );
  const expected = (swing.frames.length - 4) / swing.frames.length;
  assert.ok(Math.abs(detectionRate(camera) - expected) < 1e-9);
});

test("a dropout leaves the joint absent rather than filled in", () => {
  const anchored = runPipeline({
    dropouts: [{ joint: "leftElbow", startFrame: 40, length: 10 }],
  });
  assert.equal(anchored.frames[45].joints.leftElbow, undefined);
  assert.ok(anchored.frames[39].joints.leftElbow, "present before the gap");
  assert.ok(anchored.frames[50].joints.leftElbow, "present after the gap");
});

/* ------------------------- levelling from anatomy -------------------- */

/**
 * Roll the camera about its optical axis, as a phone on an uneven tripod is.
 *
 * Applied to the detector's WORLD landmarks, because that is where the tilt
 * actually lands: a detector's axes are aligned to the image, so its "down"
 * is the bottom of the frame rather than gravity.
 */
const withCameraRoll = (raw: readonly ObservationFrame[], degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return raw.map((frame) => ({
    ...frame,
    world:
      frame.world?.map((point) => ({
        ...point,
        x: point.x * cos - point.y * sin,
        y: point.x * sin + point.y * cos,
      })) ?? null,
  }));
};

test("which way is up is measured from the golfer, not assumed from the image", () => {
  /*
   * Nothing guarantees a camera is level, and the failure is quiet: ground
   * HEIGHT survives a tilt almost untouched, so the reconstruction looks
   * fine. What breaks is every signal comparing a position at height h to the
   * ground, each shifting by h·tan(tilt).
   *
   * The stance line between two flat feet is horizontal because of the
   * golfer's anatomy and the ground they stand on, not because of the camera.
   */
  for (const degrees of [0, 1, 2, 5, 10, -7]) {
    const rolled = withCameraRoll(detectFromClarityFrames(swing.frames), degrees);
    const anchored = anchorSequence(buildCameraSequence(rolled));

    assert.ok(
      Math.abs(anchored.anchor.gravityTiltDeg - Math.abs(degrees)) < 0.1,
      `a ${degrees}° roll was measured as ${anchored.anchor.gravityTiltDeg.toFixed(2)}°`
    );

    let worst = 0;
    for (const frame of anchored.frames) {
      const truth = swing.frames[frame.index].body.joints;
      for (const joint of CLARITY_JOINTS) {
        const observed = frame.joints[joint];
        if (!observed) continue;
        worst = Math.max(worst, distance(observed.position as Vec3, truth[joint]));
      }
    }
    assert.ok(
      worst < 0.02,
      `at ${degrees}° of roll the worst joint error was ${(worst * 1000).toFixed(0)}mm`
    );
  }
});

test("a level camera is left alone rather than nudged", () => {
  // A correction smaller than the measurement is just noise with a rotation
  // matrix attached.
  const anchored = anchorSequence(buildCameraSequence(detectFromClarityFrames(swing.frames)));
  assert.ok(
    anchored.anchor.gravityTiltDeg < 0.05,
    `an untilted clip measured ${anchored.anchor.gravityTiltDeg.toFixed(3)}° of tilt`
  );
});

test("a camera tilted far enough to splay the feet is still measured", () => {
  /*
   * The bug this pins down was silent, which is what made it dangerous.
   *
   * Flatness was judged against an absolute tolerance -- heel within 25mm of
   * toe. A camera pitched by theta raises the toes above the heels by
   * `footLength * sin(theta)`, which is 28mm at eight degrees on a 200mm
   * foot. Past that, EVERY frame looked like a heel lift, no frame passed,
   * `estimateLevelling` found nothing to measure, and the roll -- which it
   * could have recovered perfectly -- was reported as zero with no flag.
   *
   * THE ROLL A YAWED, PITCHED CAMERA ACTUALLY PRODUCES
   *
   * The levelling asks one question: how far must the image be turned for the
   * golfer's horizontals to lie horizontal in it? For the stance line that is
   * `atan2(sin yaw * sin pitch, cos yaw)` -- the angle of its IMAGE-PLANE
   * part, x and y, with no depth in it anywhere.
   *
   * Not `asin(sin yaw * sin pitch)`, which is the elevation of the line in
   * three dimensions and what this test used to expect. The two agree on a
   * level camera and part company as the pitch grows, and the difference is
   * the whole reason the estimator was rewritten: the 3D version divides by a
   * length that includes the depth component, and depth is the axis a
   * detector resolves worst.
   */
  for (const yawDeg of [0, 20, 45]) {
    for (const pitchDeg of [5, 8, 12, 15, 20]) {
      const anchored = anchorSequence(
        buildCameraSequence(detectFromClarityFrames(swing.frames, { cameraYawDeg: yawDeg, cameraPitchDeg: pitchDeg }))
      );
      const yaw = (yawDeg * Math.PI) / 180;
      const pitch = (pitchDeg * Math.PI) / 180;
      const expected =
        (Math.atan2(Math.abs(Math.sin(yaw) * Math.sin(pitch)), Math.cos(yaw)) * 180) / Math.PI;

      assert.ok(
        anchored.anchor.gravityTiltIsMeasured,
        `yaw ${yawDeg}°, pitch ${pitchDeg}°: the levelling found no reference at all`
      );
      assert.ok(
        Math.abs(anchored.anchor.gravityTiltDeg - expected) < 0.3,
        `yaw ${yawDeg}°, pitch ${pitchDeg}°: measured ${anchored.anchor.gravityTiltDeg.toFixed(2)}° of roll, expected ${expected.toFixed(2)}°`
      );
    }
  }
});

test("down the line the roll cannot be measured, and it says so", () => {
  /*
   * THE FAILURE A REAL DOWN-THE-LINE CLIP EXPOSED, AND WHY THE FIX IS A
   * REFUSAL RATHER THAN A BETTER NUMBER.
   *
   * Square to the stance line, the stance line points AT the camera. It then
   * carries no information about the roll -- turning the image about the lens
   * axis cannot move a vector lying along that axis -- and what it does carry
   * is the camera's PITCH, which a rotation about x tips straight into its y.
   * So the old estimator did not return a noisy roll down the line. It
   * returned a different angle entirely and then corrected the world by it.
   * On a real clip whose stance line lay 99% along depth it reported 13.1
   * degrees, of which none was roll.
   *
   * The obvious rescue is each foot's heel-to-toe line: horizontal for the
   * same reason, square to the stance, lying across the image exactly when
   * the stance does not. It was built and it does not work. A detector's heel
   * landmark sits up on the calcaneus and its toe landmark sits at the ball,
   * so the line between them SLOPES: measured on two real clips the toe came
   * out 45 to 69mm below the heel over a foot 120mm long, about 25 degrees,
   * on every frame of both. The fixture puts both on the ground, which is why
   * the idea survived until there was real footage to try it on.
   *
   * With no reference that is both horizontal and across the image, the
   * honest answer is that the roll is unmeasured -- which the caller can see,
   * rather than a plausible number it cannot check.
   */
  for (const pitchDeg of [0, 6, 12, 20]) {
    const anchored = anchorSequence(
      buildCameraSequence(detectFromClarityFrames(swing.frames, { cameraYawDeg: 90, cameraPitchDeg: pitchDeg }))
    );
    assert.equal(
      anchored.anchor.gravityTiltIsMeasured,
      false,
      `${pitchDeg}° of pitch down the line: the roll should be declined, not estimated`
    );
    assert.equal(
      anchored.anchor.gravityTiltDeg,
      0,
      "nothing measured means nothing applied"
    );
  }
});

test("the stance line is used for as long as it is worth using", () => {
  // It shortens across the image as the camera comes round, and with it the
  // length the angle is measured over. The cut-off is a length, not a yaw,
  // so a wide stance survives further round than a narrow one -- which is the
  // right behaviour and falls out rather than being special-cased.
  const measuredAt = (yawDeg: number) =>
    anchorSequence(
      buildCameraSequence(withCameraRoll(detectFromClarityFrames(swing.frames, { cameraYawDeg: yawDeg }), 5))
    ).anchor;

  for (const yawDeg of [0, 30, 55]) {
    const anchor = measuredAt(yawDeg);
    assert.ok(anchor.gravityTiltIsMeasured, `yaw ${yawDeg}° should still be measurable`);
    assert.ok(
      Math.abs(anchor.gravityTiltDeg - 5) < 0.3,
      `yaw ${yawDeg}°: a 5° roll measured ${anchor.gravityTiltDeg.toFixed(2)}°`
    );
  }

  assert.equal(measuredAt(85).gravityTiltIsMeasured, false, "square on, there is nothing to measure");
});

test("a measured zero and an unmeasurable one are different answers", () => {
  // The flag is the whole point. Without it a clip nobody could level looks
  // exactly like a clip that needed no levelling.
  const level = anchorSequence(buildCameraSequence(detectFromClarityFrames(swing.frames)));
  assert.equal(level.anchor.gravityTiltDeg, 0);
  assert.equal(level.anchor.gravityTiltIsMeasured, true);

  const footless = anchorSequence(
    buildCameraSequence(
      withCameraRoll(
        detectFromClarityFrames(swing.frames, {
          dropouts: (["leftHeel", "rightHeel", "leftToe", "rightToe"] as const).map((joint) => ({
            joint,
            startFrame: 0,
            length: swing.frames.length,
          })),
        }),
        6
      )
    )
  );
  assert.equal(footless.anchor.gravityTiltDeg, 0);
  assert.equal(footless.anchor.gravityTiltIsMeasured, false);
});

test("with no feet there is no vertical to measure, and it says so", () => {
  // The whole reference is anatomical, so cropping the feet removes it. The
  // flag is the only thing standing between that and a confidently level-
  // looking reconstruction built on the camera's own idea of down.
  const raw = detectFromClarityFrames(swing.frames, {
    dropouts: (["leftHeel", "rightHeel", "leftToe", "rightToe"] as const).map((joint) => ({
      joint,
      startFrame: 0,
      length: swing.frames.length,
    })),
  });
  const anchored = anchorSequence(buildCameraSequence(withCameraRoll(raw, 6)));

  assert.equal(anchored.anchor.gravityTiltDeg, 0, "no feet means no tilt measurement");
  assert.equal(anchored.anchor.anchorIsStable, false);
});

/* ----------------------- the detector's foot skeleton ------------------ */

/**
 * Raise the heel landmarks, as a real detector does.
 *
 * A detector's HEEL sits up on the calcaneus while its toe landmark sits at
 * the ball, near the ground. Measured on two real clips, planted heels rested
 * 15 to 65mm up and planted toes within a few millimetres of nothing. The
 * fixture puts all four on the sole, so this is what makes it honest.
 */
const withRaisedHeels = (raw: readonly ObservationFrame[], metres: number) =>
  raw.map((frame) => ({
    ...frame,
    world:
      frame.world?.map((point, index) =>
        // MediaPipe's world landmarks are Y-DOWN, so raising is subtracting.
        index === MP.LEFT_HEEL || index === MP.RIGHT_HEEL
          ? { ...point, y: point.y - metres }
          : point
      ) ?? null,
  }));

test("a heel landmark that rests above the ground still counts as touching it", () => {
  /*
   * THE FAILURE THIS PREVENTS, REPRODUCED.
   *
   * Contact was tested as "within 35mm of the ground". On real footage the
   * heels never passed it, so every frame of both clips reported two contact
   * points instead of four -- the two toes -- which makes the support polygon
   * a LINE. The golfer was modelled as balancing on their toe line for the
   * whole swing, and the foot-load split and support centre were computed
   * from that.
   *
   * The resting heights are measured from the clip rather than assumed, so
   * nothing here depends on a particular detector's skeleton.
   */
  const raised = 0.06;
  const anchored = anchorSequence(
    buildCameraSequence(withRaisedHeels(detectFromClarityFrames(swing.frames), raised))
  );

  // On top of the rise the fixture already gives its heel landmarks, since it
  // now places them where a detector does.
  const expected = raised + swing.anchor.footRestHeightM.leftHeel;
  for (const joint of ["leftHeel", "rightHeel"] as const) {
    assert.ok(
      Math.abs(anchored.anchor.footRestHeightM[joint] - expected) < 0.015,
      `${joint} rests at ${(anchored.anchor.footRestHeightM[joint] * 1000).toFixed(0)}mm, expected about ${(expected * 1000).toFixed(0)}mm`
    );
  }
  for (const joint of ["leftToe", "rightToe"] as const) {
    assert.ok(
      anchored.anchor.footRestHeightM[joint] < 0.015,
      `${joint} should rest on the ground, got ${(anchored.anchor.footRestHeightM[joint] * 1000).toFixed(0)}mm`
    );
  }
});

test("and the support polygon survives it, where before it collapsed to a line", () => {
  const raised = 0.06;
  const anchored = anchorSequence(
    buildCameraSequence(withRaisedHeels(detectFromClarityFrames(swing.frames), raised))
  );
  const address = anchored.frames[0];
  const joints = Object.fromEntries(
    CLARITY_JOINTS.map((joint) => [joint, address.joints[joint]!.position as Vec3])
  ) as Record<ClarityJoint, Vec3>;

  const blind = estimateMass({ joints, stanceWidthM: anchored.anchor.stanceWidthM });
  const seeing = estimateMass({
    joints,
    stanceWidthM: anchored.anchor.stanceWidthM,
    footRestHeightM: anchored.anchor.footRestHeightM,
  });

  assert.ok(
    blind.supportPolygon.length <= 2,
    `without the resting heights the polygon should collapse; it had ${blind.supportPolygon.length} points`
  );
  assert.ok(
    seeing.supportPolygon.length >= 3,
    `with them it should be a polygon again; it had ${seeing.supportPolygon.length} points`
  );
});
