/**
 * The video path's decision logic.
 *
 * Two clips that can arrive in either order, either of which can be replaced
 * or dropped. The hook around this is state plumbing; the behaviour that can
 * actually be wrong is here, so it is checked against a known body.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, distance, type ClarityFrame } from "../contracts";
import { reconstructLevelled } from "../motion/reconstruct/levelled";
import { anchorSequence } from "../observe/anchor";
import type { CameraObservationSequence, ObservationFrame } from "../observe/observation";
import { detectFromClarityFrames } from "../observe/syntheticDetector";
import { toCameraFrame } from "../observe/toCameraFrame";
import { generateSyntheticSwing } from "../synthetic/syntheticSwing";
import type { SwingKey } from "../synthetic/swingKeyframes";
import { buildVideoSequences, type SwingObservations } from "./videoSequences";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);

const standingKeys = (spineTilt: number): SwingKey[] => [
  { t: 0, theta: 0, radius: 1, pelvisYaw: 0, thoraxYaw: 0, spineTilt, thoraxRoll: 0, shiftX: 0, trailHeelLift: 0, leadHeelLift: 0 },
  { t: 2, theta: 0, radius: 1, pelvisYaw: 0, thoraxYaw: 0, spineTilt, thoraxRoll: 0, shiftX: 0, trailHeelLift: 0, leadHeelLift: 0 },
];

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

const observed = (pitchDeg: number): SwingObservations => {
  const camera = filmed(swing.frames, pitchDeg);
  return { camera, world: anchorSequence(camera) };
};

const standingShot = (pitchDeg: number, spineTiltDeg = 0) =>
  filmed(generateSyntheticSwing({ keys: standingKeys(spineTiltDeg) }).frames, pitchDeg);

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

/* ---------------------------- with and without ------------------------- */

test("no standing shot falls back to exactly what the swing can prove alone", () => {
  const swingAt = observed(8);
  const built = buildVideoSequences(swingAt, null);
  const boundary = reconstructLevelled(swingAt.camera);

  assert.equal(built.calibration, null);
  assert.equal(built.levelling.source, "falling-over-boundary");
  assert.equal(built.levelling.pitchCorrectionDeg, boundary.pitchCorrectionDeg);
});

test("a standing shot is used, and it is worth having", () => {
  const swingAt = observed(8);
  const withShot = buildVideoSequences(swingAt, standingShot(8));
  const without = buildVideoSequences(swingAt, null);

  assert.equal(withShot.levelling.source, "standing-shot");
  assert.ok(withShot.calibration?.usable);
  assert.ok(
    errorMm(withShot.reconstructed.frames) < errorMm(without.reconstructed.frames) / 3,
    `${errorMm(without.reconstructed.frames).toFixed(1)}mm without, ${errorMm(withShot.reconstructed.frames).toFixed(1)}mm with`
  );
});

/* ------------------------ the contracts the hook needs ----------------- */

test("the two clips can arrive in either order", () => {
  /*
   * The hook keeps both clips' OBSERVATIONS and rebuilds from scratch
   * whenever either changes, precisely so that this holds. If it ever tried
   * to patch the previous answer instead, loading the standing shot second
   * would drift from loading it first, and only one of those paths would
   * ever get tested by hand.
   */
  const swingAt = observed(8);
  const shot = standingShot(8);

  // Swing first: the user loads a clip, sees the boundary's answer, then adds
  // a standing shot. The hook rebuilds rather than adjusting.
  buildVideoSequences(swingAt, null);
  const swingFirst = buildVideoSequences(swingAt, shot);

  // Standing shot first: measured on its own, then a swing arrives.
  const shotFirst = buildVideoSequences(swingAt, shot);

  assert.equal(swingFirst.levelling.pitchCorrectionDeg, shotFirst.levelling.pitchCorrectionDeg);
  for (const frame of swingFirst.reconstructed.frames) {
    for (const joint of CLARITY_JOINTS) {
      assert.deepEqual(
        frame.body.joints[joint],
        shotFirst.reconstructed.frames[frame.index].body.joints[joint]
      );
    }
  }
});

test("dropping the standing shot restores the un-calibrated result exactly", () => {
  /*
   * Not "close to". The button says drop it, so what comes back has to be the
   * sequence you would have had if one had never been loaded.
   *
   * It holds because the build is a pure function of the two observation
   * sets, which is the property worth guarding: the moment this starts
   * carrying anything over between calls, dropping a calibration would leave
   * a trace of it behind and nobody would notice.
   */
  const swingAt = observed(8);
  const never = buildVideoSequences(swingAt, null);

  buildVideoSequences(swingAt, standingShot(8)); // loaded...
  const dropped = buildVideoSequences(swingAt, null); // ...then dropped

  assert.equal(dropped.levelling.pitchCorrectionDeg, never.levelling.pitchCorrectionDeg);
  assert.equal(dropped.calibration, null);
  for (const frame of dropped.reconstructed.frames) {
    for (const joint of CLARITY_JOINTS) {
      assert.deepEqual(
        frame.body.joints[joint],
        never.reconstructed.frames[frame.index].body.joints[joint]
      );
    }
  }
});

test("a refused standing shot leaves the swing on its own footing", () => {
  const swingAt = observed(8);
  const crouched = buildVideoSequences(swingAt, standingShot(8, 15));
  const without = buildVideoSequences(swingAt, null);

  assert.equal(crouched.calibration?.usable, false);
  assert.equal(crouched.levelling.source, "falling-over-boundary");
  assert.equal(crouched.levelling.pitchCorrectionDeg, without.levelling.pitchCorrectionDeg);
});

/* ------------------------------- honesty ------------------------------- */

test("the baseline beside it is never levelled", () => {
  /*
   * The passthrough exists to show what arrives with nothing done to it. If
   * the levelling reached it too, the side-by-side would be comparing two
   * corrected worlds and quietly flattering the Motion Layer.
   */
  const built = buildVideoSequences(observed(8), standingShot(8));

  assert.ok(Math.abs(built.reconstructed.anchor.pitchCorrectionDeg) > 1, "the reconstruction was levelled");
  assert.equal(built.sequence.anchor.pitchCorrectionDeg, 0, "the baseline was not");
  assert.equal(built.sequence.anchor.pitchCorrectionSource, "none");
});
