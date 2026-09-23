/**
 * The context bids, graded against ground truth.
 *
 * Two promises, and a third that matters more than either:
 *
 *   A detector whose depth is worse than its picture is corrected more along
 *   the line of sight -- measurably closer to the truth, not merely smoother.
 *
 *   A joint hidden behind the body, when hidden joints really are noisier,
 *   yields to its neighbours -- again, closer to the truth.
 *
 *   And where neither fault is present, nothing changes at all. A bid that
 *   moves a clean reconstruction is a bid inventing evidence.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CLARITY_JOINTS,
  OBSERVABLE_JOINTS,
  distance,
  dot,
  normalise,
  scale,
  sub,
  add,
  type ClarityJoint,
  type Unit,
  type Vec3,
} from "../../contracts";
import { anchorSequence } from "../../observe/anchor";
import type { CameraObservationSequence } from "../../observe/observation";
import {
  detectFromClarityFrames,
  type SyntheticDetectorOptions,
} from "../../observe/syntheticDetector";
import { toCameraFrame } from "../../observe/toCameraFrame";
import { generateSyntheticSwing } from "../../synthetic/syntheticSwing";
import { measureBodyModel } from "./bodyModel";
import { applyConstraints } from "./constraints";
import { hiddenBehind } from "./contextBids";
import { reconstruct, type ReconstructOptions } from "./reconstruct";
import { smoothTrack } from "./smoothing";

const swing = generateSyntheticSwing();
const truth = swing.frames.map((frame) => frame.body.joints);
const BIDS_OFF: ReconstructOptions = { stages: { depthBid: false, hiddenBid: false } };

const observe = (options: SyntheticDetectorOptions = {}) => {
  const raw = detectFromClarityFrames(swing.frames, options);
  const camera: CameraObservationSequence = {
    space: "camera",
    frames: raw.map((frame) => toCameraFrame(frame)),
    fps: swing.fps,
    width: 1920,
    height: 1080,
    durationMs: (swing.frames.length / swing.fps) * 1000,
    detector: "synthetic",
  };
  return anchorSequence(camera);
};

/** Mean error in mm over the joints a detector reports, optionally on chosen samples. */
const errorMm = (
  options: SyntheticDetectorOptions,
  reconstructOptions: ReconstructOptions = {},
  include: (joint: ClarityJoint, frame: number) => boolean = () => true
): number => {
  const rebuilt = reconstruct(observe(options), reconstructOptions).sequence;
  let total = 0;
  let count = 0;
  for (const frame of rebuilt.frames) {
    for (const joint of OBSERVABLE_JOINTS) {
      if (!include(joint, frame.index)) continue;
      total += distance(frame.body.joints[joint], truth[frame.index][joint]);
      count += 1;
    }
  }
  return (total / count) * 1000;
};

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/* ------------------------------ the camera ------------------------------ */

test("the camera is found where the fixture put it, from the body alone", () => {
  // The fixture films from 3.5m. Face-on the golfer faces -Z; down the line
  // the camera sits on the stance line.
  const faceOn = reconstruct(observe()).context!;
  const downTheLine = reconstruct(observe({ cameraYawDeg: -90 })).context!;
  assert.equal(faceOn.framesWithCamera, swing.frames.length);

  const faceOnCamera = faceOn.cameras[0]!;
  assert.ok(Math.abs(faceOnCamera[2] + 3.5) < 0.15, `face-on camera at z=${faceOnCamera[2].toFixed(2)}`);
  assert.ok(Math.abs(faceOnCamera[0]) < 0.15);

  const dtlCamera = downTheLine.cameras[0]!;
  assert.ok(Math.abs(Math.abs(dtlCamera[0]) - 3.5) < 0.15, `down-the-line camera at x=${dtlCamera[0].toFixed(2)}`);
  assert.ok(Math.abs(dtlCamera[2]) < 0.15);
});

/* ---------------------------- hidden geometry --------------------------- */

test("along the stance line, the far leg is hidden behind the near one, and the near leg is not", () => {
  const context = reconstruct(observe({ cameraYawDeg: -90 })).context!;
  const camera = context.cameras[0]!;
  // Which side is near depends on which end of the stance line the camera is.
  const nearIsRight = distance(camera, truth[0].rightHip) < distance(camera, truth[0].leftHip);
  const [near, far] = nearIsRight ? ["right", "left"] : ["left", "right"];

  for (const part of ["Hip", "Knee", "Ankle"]) {
    const farHidden = hiddenBehind(`${far}${part}` as ClarityJoint, truth[0], camera, 1.8);
    const nearHidden = hiddenBehind(`${near}${part}` as ClarityJoint, truth[0], camera, 1.8);
    assert.ok(farHidden.amount > 0.5, `far ${part} at address is only ${farHidden.amount.toFixed(2)} hidden`);
    assert.equal(nearHidden.amount, 0, `near ${part} reads as hidden by ${nearHidden.by}`);
  }
});

/* ----------------------------- clean input ------------------------------ */

test("on a clean clip neither bid moves anything", () => {
  const observations = observe({ cameraYawDeg: -90 });
  const withBids = reconstruct(observations);
  const without = reconstruct(observations, BIDS_OFF);

  for (const joint of CLARITY_JOINTS) assert.equal(withBids.context!.depthDoubt[joint], 1, joint);
  assert.equal(withBids.stageCounts.framesHidden, 0);

  for (const frame of withBids.sequence.frames) {
    for (const joint of CLARITY_JOINTS) {
      const moved = distance(frame.body.joints[joint], without.sequence.frames[frame.index].body.joints[joint]);
      assert.ok(moved < 1e-9, `${joint} moved ${moved}m on frame ${frame.index}`);
    }
  }
});

/* ------------------------------ line of sight --------------------------- */

test("depth noise is measured as depth noise, and even noise is not", () => {
  const depthy = reconstruct(observe({ depthNoiseM: 0.02 })).context!;
  assert.ok(median(Object.values(depthy.depthDoubt)) > 4, "depth noise was not measured as worse than the picture");

  const even = reconstruct(observe({ jointNoiseM: () => 0.014 })).context!;
  assert.ok(median(Object.values(even.depthDoubt)) < 1.5, "noise equal in every direction read as depth doubt");
});

test("depth noise alone does not trip the hidden bid", () => {
  // Depth is the line-of-sight bid's to price. Counting it again as
  // "hidden" would charge a far joint twice for one fault.
  for (const yaw of [0, -90]) {
    const report = reconstruct(observe({ cameraYawDeg: yaw, depthNoiseM: 0.02 }));
    assert.equal(report.stageCounts.framesHidden, 0, `yaw ${yaw}: ${report.stageCounts.framesHidden} samples discounted`);
  }
});

test("with a detector bad at depth, the line-of-sight bid brings the body closer to the truth", () => {
  for (const yaw of [0, -90, 45]) {
    const options = { cameraYawDeg: yaw, depthNoiseM: 0.02 };
    const off = errorMm(options, BIDS_OFF);
    const on = errorMm(options);
    assert.ok(on < off * 0.9, `yaw ${yaw}: ${on.toFixed(1)}mm with the bid against ${off.toFixed(1)}mm without`);
  }
});

/* --------------------------------- hidden ------------------------------- */

test("with a detector bad at hidden joints, the hidden bid brings them closer to the truth", () => {
  const cameras = reconstruct(observe()).context!.cameras;
  const hidden = (joint: ClarityJoint, frame: number) =>
    hiddenBehind(joint, truth[frame], cameras[frame]!, 1.8).amount > 0.5;
  const visible = (joint: ClarityJoint, frame: number) => !hidden(joint, frame);

  const options: SyntheticDetectorOptions = {
    jointNoiseM: (joint, frame) => (hidden(joint, frame) ? 0.04 : 0.004),
  };
  const lineOfSightOnly: ReconstructOptions = { stages: { hiddenBid: false } };

  const hiddenOff = errorMm(options, lineOfSightOnly, hidden);
  const hiddenOn = errorMm(options, {}, hidden);
  assert.ok(hiddenOn < hiddenOff * 0.95, `hidden joints: ${hiddenOn.toFixed(1)}mm with the bid, ${hiddenOff.toFixed(1)}mm without`);

  // What the hidden joints gave up must not have been taken from the visible ones.
  const visibleOff = errorMm(options, lineOfSightOnly, visible);
  const visibleOn = errorMm(options, {}, visible);
  assert.ok(visibleOn <= visibleOff + 0.1, `visible joints: ${visibleOn.toFixed(1)}mm with the bid, ${visibleOff.toFixed(1)}mm without`);
});

test("provenance says what the bids did, joint by joint", () => {
  const report = reconstruct(observe({ cameraYawDeg: -90, depthNoiseM: 0.02 }));
  const provenance = report.sequence.frames[0].provenance.joints;
  const camera = report.context!.cameras[0]!;
  const far: ClarityJoint =
    distance(camera, truth[0].rightHip) < distance(camera, truth[0].leftHip) ? "leftHip" : "rightHip";

  assert.ok(provenance[far].context, "no context recorded on the far hip");
  assert.ok(provenance[far].context!.hidden > 0.5);
  // The top of the near thigh or the near side of the trunk, whichever the
  // line of sight passes deeper through.
  assert.match(provenance[far].context!.hiddenBy ?? "", /thigh|side of the trunk/);
  // Depth noise alone: seen as hidden, but not charged for it.
  assert.equal(provenance[far].context!.hiddenTrust, 1);
  assert.ok(provenance.leftWrist.context!.depthDoubt > 1);
});

/* -------------------------------- solver -------------------------------- */

const modelFromSwing = () => {
  const tracks = {} as Parameters<typeof measureBodyModel>[0];
  for (const joint of CLARITY_JOINTS) {
    tracks[joint] = {
      joint,
      samples: swing.frames.map((frame) => ({ position: frame.body.joints[joint], visibility: 0.95 })),
    };
  }
  return measureBodyModel(tracks, swing.frames.length);
};

test("a joint doubted along its line of sight gives way along it, and the bone is still restored", () => {
  const model = modelFromSwing();
  const joints = { ...truth[0] };
  const forearm = normalise(sub(joints.leftWrist, joints.leftElbow));
  const target = distance(joints.leftWrist, joints.leftElbow);
  // Stretch the forearm by 5cm, then doubt the wrist along a ray 60 degrees off it.
  joints.leftWrist = add(joints.leftWrist, scale(forearm, 0.05));
  const sideways = normalise(sub(joints.leftShoulder, joints.rightShoulder));
  const across = normalise(sub(sideways, scale(forearm, dot(sideways, forearm))));
  const ray = normalise(add(scale(forearm, 0.5), scale(across, Math.sqrt(0.75))));

  const trust = {} as Record<ClarityJoint, Unit>;
  for (const joint of CLARITY_JOINTS) trust[joint] = 0.9;

  const solved = applyConstraints({
    joints,
    trust,
    model,
    depthDoubt: { leftWrist: { ray, ratio: 9 } },
  });

  const step = sub(solved.joints.leftWrist, joints.leftWrist);
  const alongRay = Math.abs(dot(step, ray)) / Math.hypot(...step);
  assert.ok(alongRay > 0.9, `only ${(alongRay * 100).toFixed(0)}% of the wrist's move was along its line of sight`);

  const after = distance(solved.joints.leftWrist, solved.joints.leftElbow);
  assert.ok(Math.abs(after - target) < target * 0.03, `forearm left at ${after.toFixed(3)}m against ${target.toFixed(3)}m`);
});

test("without doubt the solver splits exactly as it always did", () => {
  const model = modelFromSwing();
  const joints = { ...truth[0] };
  joints.leftWrist = add(joints.leftWrist, [0.04, -0.02, 0.01]);
  const trust = {} as Record<ClarityJoint, Unit>;
  for (const joint of CLARITY_JOINTS) trust[joint] = joint === "leftWrist" ? 0.4 : 0.9;

  const plain = applyConstraints({ joints, trust, model });
  const unitDoubt = applyConstraints({
    joints,
    trust,
    model,
    depthDoubt: { leftWrist: { ray: [0, 0, 1], ratio: 1 } },
  });
  for (const joint of CLARITY_JOINTS) {
    assert.ok(distance(plain.joints[joint], unitDoubt.joints[joint]) < 1e-12, joint);
  }
});

/* ------------------------------- smoother ------------------------------- */

test("the smoother settles a depth error harder than the same error across the picture", () => {
  const ray: Vec3 = [0, 0, 1];
  const straight = Array.from({ length: 21 }, (_value, index): Vec3 => [index * 0.01, 1, 0]);
  const offset = (by: Vec3) => straight.map((point, index) => (index === 10 ? add(point, by) : point));
  const run = (positions: Vec3[], doubted: boolean) =>
    smoothTrack({
      positions,
      trust: positions.map(() => 0.9),
      strength: positions.map(() => 0.3),
      doubt: positions.map(() => (doubted ? { ray, ratio: 9 } : null)),
    }).positions[10];

  const depthError = offset([0, 0, 0.02]);
  const pictureError = offset([0, 0.02, 0]);

  const depthLeft = distance(run(depthError, true), straight[10]);
  const depthLeftPlain = distance(run(depthError, false), straight[10]);
  assert.ok(depthLeft < depthLeftPlain * 0.7, `depth error ${(depthLeft * 1000).toFixed(1)}mm, undoubted ${(depthLeftPlain * 1000).toFixed(1)}mm`);

  // Across the ray the doubt changes nothing.
  const pictureLeft = distance(run(pictureError, true), straight[10]);
  const pictureLeftPlain = distance(run(pictureError, false), straight[10]);
  assert.ok(Math.abs(pictureLeft - pictureLeftPlain) < 1e-12);
});
