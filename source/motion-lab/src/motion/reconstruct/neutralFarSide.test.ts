/**
 * The far side's zero point, checked on its promises.
 *
 * Down the line, a far leg the detector splayed in depth is brought back to
 * a neutral stance at address -- 50/50, stacked -- and keeps the movement
 * the detector saw through the swing. Face on, nothing happens. A clean clip
 * is left as it was.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { distance, type ClarityJoint, type Vec3 } from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import type { WorldObservationSequence } from "../../observe/observation";
import { detectFromClarityFrames } from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { reconstruct } from "./reconstruct";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);
const FAR_LEG: readonly ClarityJoint[] = ["leftKnee", "leftAnkle", "leftHeel", "leftToe"];
const ADDRESS = 24;

/**
 * The far leg pushed along the stance line -- the world's X axis -- by a
 * constant bias, and seen a little worse than the near one, as it is.
 */
const observe = (cameraYawDeg: number, biasM: number): WorldObservationSequence => {
  const raw = detectFromClarityFrames(swing.frames, { cameraYawDeg });
  const sequence = anchorSequence({
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (swing.frames.length / swing.fps) * 1000,
    detector: "synthetic",
  });
  return {
    ...sequence,
    frames: sequence.frames.map((frame) => {
      const joints = { ...frame.joints };
      for (const joint of FAR_LEG) {
        const seen = joints[joint];
        if (!seen) continue;
        joints[joint] = {
          ...seen,
          visibility: seen.visibility * 0.7,
          position: [seen.position[0] + biasM, seen.position[1], seen.position[2]] as Vec3,
        };
      }
      return { ...frame, joints };
    }),
  };
};

const legError = (
  frames: readonly { body: { joints: Record<ClarityJoint, Vec3> } }[],
  from: number,
  to: number
): number => {
  let total = 0;
  let count = 0;
  for (let index = from; index < to; index += 1) {
    for (const joint of FAR_LEG) {
      total += distance(frames[index].body.joints[joint], truth[index][joint]);
      count += 1;
    }
  }
  return total / count;
};

for (const biasM of [0.2, -0.2]) {
  test(`down the line, a far leg splayed ${biasM * 100} cm is zeroed to a neutral stance`, () => {
    const off = reconstruct(observe(-90, biasM), { stages: { neutralFarSide: false } });
    const on = reconstruct(observe(-90, biasM));

    assert.equal(on.neutral?.farSide, "left");
    const before = legError(off.sequence.frames, 0, ADDRESS);
    const after = legError(on.sequence.frames, 0, ADDRESS);
    assert.ok(after < 0.03, `far leg ${(after * 1000).toFixed(0)}mm off at address, ${(before * 1000).toFixed(0)}mm without`);

    // 50/50 at address, which the splay had turned into a lean.
    const share = on.sequence.frames[0].mass?.footShare.left ?? 0;
    assert.ok(Math.abs(share - 0.5) < 0.05, `lead foot carries ${(share * 100).toFixed(0)}%`);
  });
}

test("the zero point is an offset, not a hold: the swing still moves the far leg", () => {
  // Through the whole swing, not just address -- a hold would leave the leg
  // standing while the truth turned through impact.
  const off = reconstruct(observe(-90, 0.2), { stages: { neutralFarSide: false } });
  const on = reconstruct(observe(-90, 0.2));
  const all = truth.length;
  const before = legError(off.sequence.frames, 0, all);
  const after = legError(on.sequence.frames, 0, all);
  assert.ok(after < before * 0.25, `swing-long far leg ${(after * 1000).toFixed(0)}mm, ${(before * 1000).toFixed(0)}mm without`);
});

test("a clean down-the-line clip is left as it was", () => {
  const report = reconstruct(observe(-90, 0));
  for (const shift of Object.values(report.neutral?.shiftM ?? {})) {
    assert.ok(Math.abs(shift ?? 0) < 0.01, `moved a clean leg ${((shift ?? 0) * 1000).toFixed(0)}mm`);
  }
});

test("face on, the far leg is in view, and the stage stands aside", () => {
  const report = reconstruct(observe(0, 0.2));
  assert.equal(report.neutral?.applied, false);
  assert.match(report.neutral?.skipped ?? "", /not down the line/);
});
