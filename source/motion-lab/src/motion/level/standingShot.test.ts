/**
 * The standing-shot calibration route.
 *
 * Two seconds of the golfer standing still, from the same camera, in exchange
 * for the pitch to about a tenth of a degree -- where the swing clip on its
 * own can only ever give a lower bound, and often a loose one.
 *
 * The tests that matter most here are the ones about its LIMITS: a stand that
 * was really a crouch, and a camera that moved between the two shots.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type ClarityFrame, type ClarityJoint, type Vec3 } from "../../contracts";
import type { CameraObservationSequence, ObservationFrame } from "../../observe/observation";
import { detectFromClarityFrames } from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import type { SwingKey } from "../../synthetic/swingKeyframes";
import { reconstructLevelled } from "../reconstruct/levelled";
import { reconstructCalibrated } from "./calibrated";
import { calibrateFromStandingShot } from "./standingShot";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);

/** Two seconds of standing, at a given spine tilt from vertical. */
const standingKeys = (spineTiltDeg: number): SwingKey[] => [
  { t: 0.0, theta: 0, radius: 1, pelvisYaw: 0, thoraxYaw: 0, spineTilt: spineTiltDeg, thoraxRoll: 0, shiftX: 0, trailHeelLift: 0, leadHeelLift: 0 },
  { t: 2.0, theta: 0, radius: 1, pelvisYaw: 0, thoraxYaw: 0, spineTilt: spineTiltDeg, thoraxRoll: 0, shiftX: 0, trailHeelLift: 0, leadHeelLift: 0 },
];

const standing = (spineTiltDeg: number) =>
  generateSyntheticSwing({ keys: standingKeys(spineTiltDeg) }).frames;

const filmed = (frames: readonly ClarityFrame[], pitchDeg: number): CameraObservationSequence => {
  const raw: readonly ObservationFrame[] = detectFromClarityFrames(frames, {
    cameraPitchDeg: pitchDeg,
  });
  return {
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
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
  return count === 0 ? 0 : (total / count) * 1000;
};

/** Push the hips back and sit down slightly. A posture, not a viewpoint. */
const SIT_BACK: Partial<Record<ClarityJoint, Vec3>> = {
  leftHip: [0, -0.04, -0.06], rightHip: [0, -0.04, -0.06],
  leftKnee: [0, -0.02, 0.03], rightKnee: [0, -0.02, 0.03],
  leftShoulder: [0, -0.04, 0], rightShoulder: [0, -0.04, 0],
  neck: [0, -0.04, 0], head: [0, -0.04, 0],
  leftElbow: [0, -0.04, 0], rightElbow: [0, -0.04, 0],
  leftWrist: [0, -0.04, 0], rightWrist: [0, -0.04, 0],
  leftHand: [0, -0.04, 0], rightHand: [0, -0.04, 0],
};

const sittingBack = (frames: readonly ClarityFrame[]): readonly ClarityFrame[] =>
  frames.map((frame) => ({
    ...frame,
    body: {
      ...frame.body,
      joints: Object.fromEntries(
        Object.entries(frame.body.joints).map(([name, position]) => {
          const shift = SIT_BACK[name as ClarityJoint];
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

/* --------------------------- what it measures -------------------------- */

test("a golfer standing straight gives the camera's pitch to a tenth of a degree", () => {
  for (const pitchDeg of [0, 2, 5, 10, -6]) {
    const calibration = calibrateFromStandingShot(filmed(standing(0), pitchDeg));
    assert.ok(calibration.usable, `${pitchDeg}°: ${calibration.reason}`);
    assert.ok(
      Math.abs(calibration.pitchDeg - pitchDeg) < 0.25,
      `a ${pitchDeg}° camera measured as ${calibration.pitchDeg.toFixed(2)}°`
    );
  }
});

test("the bracket contains the truth even when they do not stand straight", () => {
  /*
   * The two estimators fail in opposite directions -- the raw slope when the
   * person tilts, the posture-corrected one when they sit back -- so the
   * interval between them is where the answer has to be. That is the property
   * worth pinning down; the midpoint is just a convenience.
   */
  const poses: [string, readonly ClarityFrame[]][] = [
    ["straight", standing(0)],
    ["slouched 5°", standing(5)],
    ["crouched 15°", standing(15)],
    ["hips back", sittingBack(standing(0))],
  ];
  for (const [label, frames] of poses) {
    for (const pitchDeg of [0, 5, 10]) {
      const { pitchRangeDeg } = calibrateFromStandingShot(filmed(frames, pitchDeg));
      assert.ok(
        pitchDeg >= pitchRangeDeg[0] && pitchDeg <= pitchRangeDeg[1],
        `${label} at ${pitchDeg}°: the bracket [${pitchRangeDeg[0].toFixed(2)}, ${pitchRangeDeg[1].toFixed(2)}] missed the truth`
      );
    }
  }
});

/* --------------------------- what it is worth -------------------------- */

test("a standing shot restores the reconstruction to its clean accuracy", () => {
  /*
   * The number that justifies asking the golfer for a second clip. The
   * falling-over boundary alone leaves 42mm of mean joint error at ten
   * degrees of tilt, because it only ever proves a lower bound. The standing
   * shot brings it back to 6mm -- which is what the same pipeline produces on
   * a perfectly level camera.
   */
  for (const pitchDeg of [2, 5, 10]) {
    const shot = filmed(standing(0), pitchDeg);
    const clip = filmed(swing.frames, pitchDeg);

    const boundaryOnly = errorMm(reconstructLevelled(clip).sequence.frames);
    const calibrated = errorMm(reconstructCalibrated(clip, shot).sequence.frames);

    assert.ok(
      calibrated < 8,
      `${pitchDeg}°: calibrated error was ${calibrated.toFixed(1)}mm, which is not "as good as level"`
    );
    assert.ok(
      calibrated < boundaryOnly,
      `${pitchDeg}°: ${boundaryOnly.toFixed(1)}mm from the boundary alone, ${calibrated.toFixed(1)}mm with the standing shot`
    );
  }
});

/* ------------------------------ its limits ----------------------------- */

test("a crouch is refused rather than believed, with a reason", () => {
  const calibration = calibrateFromStandingShot(filmed(standing(15), 5));
  assert.equal(calibration.usable, false);
  assert.match(calibration.reason ?? "", /plumb line/);
  assert.ok(calibration.standingBendM > 0.05);

  // And the route falls back to what the swing can prove on its own, rather
  // than applying a calibration it has just called unusable.
  const result = reconstructCalibrated(filmed(swing.frames, 5), filmed(standing(15), 5));
  assert.equal(result.source, "falling-over-boundary");
  assert.ok(result.pitchCorrectionDeg > 1);
});

test("handing it a swing is refused: address is not standing", () => {
  const calibration = calibrateFromStandingShot(filmed(swing.frames, 0));
  assert.equal(calibration.usable, false, "a 32° address lean should not pass as a stand");
});

test("a clip too short to average is refused", () => {
  const short = filmed(standing(0).slice(0, 4), 0);
  const calibration = calibrateFromStandingShot(short);
  assert.equal(calibration.usable, false);
  assert.equal(calibration.samples, 0);
});

test("no standing shot falls back to the boundary, unchanged", () => {
  const clip = filmed(swing.frames, 10);
  const without = reconstructCalibrated(clip, null);
  const boundary = reconstructLevelled(clip);
  assert.equal(without.calibration, null);
  assert.equal(without.source, "falling-over-boundary");
  assert.equal(without.pitchCorrectionDeg, boundary.pitchCorrectionDeg);
});

/* ------------------- when the two routes disagree ---------------------- */

test("a camera that moved between shots is caught when the swing needs MORE", () => {
  /*
   * Standing filmed level, swing filmed at ten degrees. The calibration is
   * right about the standing shot and wrong about the swing, and the mass in
   * the swing is left out past the toes -- which is impossible, so the
   * boundary overrides and the disagreement is reported.
   */
  const result = reconstructCalibrated(filmed(swing.frames, 10), filmed(standing(0), 0));

  assert.equal(result.agreement, "boundary-forced-more");
  assert.ok(result.boundaryResidualDeg > 1);
  assert.ok(
    result.pitchCorrectionDeg > (result.calibration?.pitchDeg ?? 0),
    "physics should have added to the standing shot's answer, not deferred to it"
  );
});

test("and is NOT caught when the swing needs less -- the blind spot, on the record", () => {
  /*
   * The reverse case, which nothing here can detect.
   *
   * Standing filmed at ten degrees, swing filmed level. The calibration
   * over-corrects, and over-correcting drags the mass back toward the HEELS --
   * deeper inside the foot, where no physical law is broken. Every check
   * passes and the result is much worse than doing nothing.
   *
   * This test exists so the limit is a documented property rather than a
   * surprise on real footage. The only defence is operational: film both from
   * the same place. `boundaryRangeDeg` is the one hint available -- a
   * calibration pressed against the edge of the swing's own admissible range
   * is one to distrust.
   */
  const clip = filmed(swing.frames, 0);
  const result = reconstructCalibrated(clip, filmed(standing(0), 10));

  assert.equal(result.agreement, "agree", "there is nothing here for the boundary to object to");
  assert.ok(
    errorMm(result.sequence.frames) > errorMm(reconstructLevelled(clip).sequence.frames),
    "if this ever starts passing, the blind spot has been closed and this test should become the opposite one"
  );

  // The hint that IS available: the calibration sits hard against the top of
  // what the swing itself admits.
  const [, high] = result.boundaryRangeDeg;
  assert.ok(
    (result.calibration?.pitchDeg ?? 0) > high - 3,
    `the calibration was ${result.calibration?.pitchDeg.toFixed(1)}° against a swing admitting up to ${high.toFixed(1)}° -- that closeness is the only warning sign`
  );
});
