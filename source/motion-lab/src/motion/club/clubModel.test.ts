/**
 * The club model, graded against a club whose position is known.
 *
 * The synthetic swing carries a real 3D club, so it can be projected to the
 * image exactly as a detector would see it and then recovered. That makes the
 * central claim testable: that a CBP DERIVED from constrained geometry is
 * steadier than the clubhead detection it came from.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, lerpVec, sub, type Vec3 } from "../../contracts";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { fitCamera, project, type Camera } from "./camera";
import { bodyObstacles } from "./occupancy";
import { perspectiveCamera } from "./testCamera";
import { estimateClub, type ClubFrameInput } from "./clubModel";

const swing = generateSyntheticSwing();

/**
 * A camera on a circle around the golfer, at the given angle from face-on.
 *
 * Zero looks at the front of the stance; ninety looks down the stance line.
 * Distance and height are what a coach filming on a phone would actually use.
 */
const cameraAt = (yawDeg: number) => {
  const radians = (yawDeg * Math.PI) / 180;
  const distanceM = 4.6;
  /*
   * Negated in Z so that zero really does look at the FRONT of the stance:
   * a golfer's toes point along -Z (see `contracts/units`), so a camera on
   * +Z would be filming the back of their head while the name said face-on.
   */
  return perspectiveCamera(
    [Math.sin(radians) * distanceM, 1.55, -Math.cos(radians) * distanceM],
    [0, 1.0, -0.3]
  );
};

interface BuildOptions {
  readonly yawDeg?: number;
  /** Gaussian-ish jitter added to the detected clubhead, normalised image units. */
  readonly detectionNoise?: number;
  /** Frames where the detector finds no clubhead. */
  readonly blind?: (index: number) => boolean;
  readonly detectionConfidence?: number;
}

const handsOf = (index: number): Vec3 =>
  lerpVec(
    swing.frames[index].body.joints.leftHand,
    swing.frames[index].body.joints.rightHand,
    0.5
  );

const buildInputs = (options: BuildOptions = {}): ClubFrameInput[] => {
  const matrix = cameraAt(options.yawDeg ?? 25).matrix;
  // Deterministic jitter: a test that flakes teaches nothing.
  let seed = 12345;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed / 0x7fffffff) * 2 - 1) * (options.detectionNoise ?? 0);
  };

  return swing.frames.map((frame, index) => {
    const camera: Camera | null = fitCamera(
      CLARITY_JOINTS.flatMap((joint) => {
        const world = frame.body.joints[joint];
        const image = project(matrix, world);
        return image ? [{ world, image, weight: 0.9 }] : [];
      })
    );

    const head = frame.club!.head;
    const image = project(matrix, head)!;
    const blind = options.blind?.(index) ?? false;

    return {
      hands: handsOf(index),
      wrists: lerpVec(frame.body.joints.leftWrist, frame.body.joints.rightWrist, 0.5),
      transverse: [
        frame.body.joints.rightShoulder[0] - frame.body.joints.leftShoulder[0],
        frame.body.joints.rightShoulder[1] - frame.body.joints.leftShoulder[1],
        frame.body.joints.rightShoulder[2] - frame.body.joints.leftShoulder[2],
      ] as Vec3,
      obstacles: bodyObstacles(frame.body.joints, 1.8),
      forearms: [
        sub(frame.body.joints.leftElbow, frame.body.joints.leftWrist),
        sub(frame.body.joints.rightElbow, frame.body.joints.rightWrist),
      ],
      camera,
      observation: blind
        ? null
        : {
            imageX: image[0] + jitter(),
            imageY: image[1] + jitter(),
            imageRadius: 0.02,
            confidence: options.detectionConfidence ?? 0.85,
          },
    };
  });
};

/** True hands-to-head distance, which the fixture lets vary a little. */
const trueSpan = (index: number) =>
  distance(handsOf(index), swing.frames[index].club!.head);

/* ------------------------------------------------------------------ */

test("the club's length is measured from viewing-line bounds alone", () => {
  const result = estimateClub(buildInputs());

  const spans = swing.frames.map((_frame, index) => trueSpan(index));
  const maxSpan = Math.max(...spans);

  assert.ok(result.shaftLengthM > 0.5, `measured ${result.shaftLengthM.toFixed(3)}m`);
  assert.ok(
    Math.abs(result.shaftLengthM - maxSpan) < 0.05,
    `measured ${result.shaftLengthM.toFixed(3)}m against a true span of up to ${maxSpan.toFixed(3)}m`
  );
  assert.equal(result.observedFrames, swing.frames.length);
  assert.ok(result.seedFrame !== null);
});

test("the clubhead is recovered in 3D, on the right side of the camera", () => {
  const result = estimateClub(buildInputs());

  let worst = 0;
  let worstFrame = -1;
  for (let index = 0; index < result.frames.length; index += 1) {
    const club = result.frames[index];
    assert.ok(club, `frame ${index} produced no club`);
    const error = distance(club.head, swing.frames[index].club!.head);
    if (error > worst) {
      worst = error;
      worstFrame = index;
    }
  }

  // A mirrored branch choice would be hundreds of millimetres out, so this
  // threshold is really a test that continuity resolved the ambiguity.
  assert.ok(
    worst < 0.09,
    `worst clubhead error ${(worst * 1000).toFixed(0)}mm at frame ${worstFrame}`
  );
});

test("the CBP lies on the shaft it was derived from", () => {
  // Not detected from pixels: derived from geometry. If it ever leaves the
  // line between the club's ends, it has stopped being derived.
  const result = estimateClub(buildInputs());
  for (const club of result.frames) {
    assert.ok(club);
    const shaft = [
      club.head[0] - club.grip[0],
      club.head[1] - club.grip[1],
      club.head[2] - club.grip[2],
    ] as Vec3;
    const toCbp = [
      club.cbp[0] - club.grip[0],
      club.cbp[1] - club.grip[1],
      club.cbp[2] - club.grip[2],
    ] as Vec3;
    const shaftLength = Math.hypot(...shaft);
    const along =
      (toCbp[0] * shaft[0] + toCbp[1] * shaft[1] + toCbp[2] * shaft[2]) / shaftLength;
    const perpendicular = Math.sqrt(
      Math.max(0, toCbp[0] ** 2 + toCbp[1] ** 2 + toCbp[2] ** 2 - along ** 2)
    );
    assert.ok(perpendicular < 1e-6, `CBP is ${perpendicular}m off the shaft`);
    assert.ok(along > 0 && along < shaftLength * 1.1, "CBP is outside the club");
  }
});

test("the derived CBP is steadier than the detection it came from", () => {
  /*
   * The plan's central claim about the club, as a measurement.
   *
   * A clubhead detection that wobbles -- lighting, motion blur, the head
   * turning over -- must not move the balance point by the same amount,
   * because the CBP is pinned by a club of fixed length attached to the
   * hands. Most of the wobble has nowhere to go.
   */
  const clean = estimateClub(buildInputs());
  const noisy = estimateClub(buildInputs({ detectionNoise: 0.012 }));

  let headShift = 0;
  let cbpShift = 0;
  let count = 0;
  for (let index = 0; index < clean.frames.length; index += 1) {
    const a = clean.frames[index];
    const b = noisy.frames[index];
    if (!a || !b) continue;
    headShift += distance(a.head, b.head);
    cbpShift += distance(a.cbp, b.cbp);
    count += 1;
  }
  headShift /= count;
  cbpShift /= count;

  assert.ok(headShift > 0.01, `the injected noise barely moved the head (${headShift})`);
  assert.ok(
    cbpShift < headShift * 0.75,
    `CBP moved ${(cbpShift * 1000).toFixed(1)}mm against a head shift of ${(headShift * 1000).toFixed(1)}mm ` +
      "-- the derivation is not damping the detection"
  );
});

test("losing the clubhead carries the CBP for a while, then stops", () => {
  const lostFrom = 80;
  const result = estimateClub(buildInputs({ blind: (index) => index >= lostFrom }), {
    maxCarryFrames: 12,
  });

  const before = result.frames[lostFrom - 1]!;
  assert.equal(before.evidence.headObserved, true);

  const carried = result.frames[lostFrom + 4]!;
  assert.ok(carried, "the club should still be supported a few frames after the loss");
  assert.equal(carried.evidence.headObserved, false);
  assert.ok(carried.evidence.framesSinceHeadObserved > 0);
  assert.ok(
    carried.confidence < before.confidence,
    "confidence must fall once direct evidence is gone"
  );

  const later = result.frames[lostFrom + 10]!;
  assert.ok(later, "still carrying at ten frames");
  assert.ok(
    later.confidence < carried.confidence,
    "confidence must keep falling, not settle"
  );

  // Past the carry limit the club is not reported at all.
  assert.equal(
    result.frames[lostFrom + 14],
    null,
    "club movement was still being invented past the carry limit"
  );
});

test("a carried club swings with the hands rather than hanging in space", () => {
  /*
   * What carrying can and cannot do.
   *
   * CAN: keep the club in the hands and swinging with them, because the shaft
   * direction is held in the hands' own frame rather than the world's. A
   * world-space hold would leave the club behind as the hands turned out from
   * under it, which looks like the club detaching.
   *
   * CANNOT: know that the wrists are releasing. Through a downswing the club
   * rotates hard relative to the forearms, and no amount of hand geometry
   * reveals that -- which is exactly why the confidence decays and the carry
   * stops. The test therefore asks that carrying beats freezing, not that it
   * is accurate.
   */
  const lostFrom = 70;
  const result = estimateClub(buildInputs({ yawDeg: 45, blind: (index) => index >= lostFrom }), {
    maxCarryFrames: 14,
  });

  const frozen = result.frames[lostFrom - 1]!.head;
  let carriedError = 0;
  let frozenError = 0;
  let counted = 0;

  for (let index = lostFrom; index < lostFrom + 10; index += 1) {
    const club = result.frames[index];
    assert.ok(club, `frame ${index} lost its club early`);

    assert.ok(
      distance(club.grip, handsOf(index)) < 1e-9,
      "a carried club must stay attached to the hands"
    );

    const truth = swing.frames[index].club!.head;
    carriedError += distance(club.head, truth);
    frozenError += distance(frozen, truth);
    counted += 1;
  }

  assert.ok(
    carriedError < frozenError * 0.7,
    `carrying (${(carriedError / counted * 1000).toFixed(0)}mm) should beat freezing ` +
      `(${(frozenError / counted * 1000).toFixed(0)}mm)`
  );
});

test("no clubhead anywhere in the clip means no club, not a guess", () => {
  const result = estimateClub(buildInputs({ blind: () => true }));
  assert.equal(result.shaftLengthM, 0);
  assert.equal(result.observedFrames, 0);
  assert.equal(result.seedFrame, null);
  assert.ok(result.frames.every((club) => club === null));
});

test("confidence follows the evidence, not the picture", () => {
  // At 45 degrees the depth is well evidenced, so what is left varying is the
  // detector's own confidence -- which is what this test is about.
  const confident = estimateClub(buildInputs({ yawDeg: 45, detectionConfidence: 0.95 }));
  const doubtful = estimateClub(buildInputs({ yawDeg: 45, detectionConfidence: 0.25 }));

  const meanConfidence = (result: ReturnType<typeof estimateClub>) => {
    const values = result.frames.filter(Boolean).map((club) => club!.confidence);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  assert.ok(
    meanConfidence(doubtful) < meanConfidence(confident) * 0.5,
    "a detector that is unsure should produce an unsure club"
  );
  assert.ok(
    meanConfidence(confident) > 0.35,
    `a well-evidenced club should read as trusted, got ${meanConfidence(confident).toFixed(2)}`
  );
});

const worstHeadError = (result: ReturnType<typeof estimateClub>) => {
  let worst = 0;
  for (let index = 0; index < result.frames.length; index += 1) {
    const club = result.frames[index];
    if (!club) continue;
    worst = Math.max(worst, distance(club.head, swing.frames[index].club!.head));
  }
  return worst;
};

test("the club is recovered wherever the wrist can settle its depth", () => {
  /*
   * A single viewpoint cannot determine depth -- the club pointing toward the
   * camera and away from it produce identical images -- so this is really a
   * test of the anatomical cue, across the angles where it has something to
   * say.
   */
  for (const yawDeg of [45, 60, 75, 90, 120, -60, -90]) {
    const result = estimateClub(buildInputs({ yawDeg }));
    const worst = worstHeadError(result);
    assert.ok(
      worst < 0.06,
      `at ${yawDeg} degrees the worst clubhead error was ${(worst * 1000).toFixed(0)}mm`
    );
  }
});

test("square to the camera, the depth is a guess -- and says so", () => {
  /*
   * THE KNOWN LIMIT, WRITTEN DOWN.
   *
   * Filmed face-on, the club swings mostly toward and away from the lens. Its
   * two candidate depths then leave the wrist angle identical to within a
   * degree and both miss the body, so nothing in the physics distinguishes
   * them. Measured: the wrist cue separates the true trajectory from its
   * mirror by 39 degrees at 45 degrees of camera yaw, by 16 at 30, and by
   * nothing at all at zero.
   *
   * The consequence is specific and worth stating plainly rather than
   * burying: the clubhead's position IN THE IMAGE stays correct, and its
   * DEPTH can be several hundred millimetres wrong. That is exactly the error
   * a face-on viewer cannot see and a 3D view can.
   *
   * So the club reports it. Nothing here pretends the number is better than
   * it is.
   */
  const unsettled = estimateClub(buildInputs({ yawDeg: 0 }));
  const settled = estimateClub(buildInputs({ yawDeg: 60 }));

  assert.ok(
    unsettled.depthEvidence < settled.depthEvidence,
    "face-on depth should be the less evidenced of the two"
  );

  const meanOf = (r: ReturnType<typeof estimateClub>) => {
    const values = r.frames.filter(Boolean).map((club) => club!.confidence);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  assert.ok(
    meanOf(unsettled) < 0.35,
    `an unsettled depth must read as unsure, got ${meanOf(unsettled).toFixed(2)}`
  );
  assert.ok(
    meanOf(settled) > meanOf(unsettled) * 1.8,
    "a settled depth should be visibly more trusted"
  );
});
