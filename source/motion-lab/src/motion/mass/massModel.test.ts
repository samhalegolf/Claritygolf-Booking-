import { strict as assert } from "node:assert";
import { test } from "node:test";

import { CLARITY_JOINTS, type ClarityJoint, type Vec3 } from "../../contracts";
import {
  buildMassCloud,
  constrainToPolygonXZ,
  convexHullXZ,
  estimateMass,
} from "./massModel";
import { MASS_PARCELS, TOTAL_MASS_UNITS, UPPER_PARCELS } from "./segmentMass";

/**
 * A plain standing pose, feet flat, facing +Z, 1.8m tall.
 *
 * Built by hand rather than by the synthetic generator so these tests fail
 * for one reason only. Everything is symmetric about X = 0, which makes the
 * expected mass centre exactly 0 on X and turns "is it balanced?" into an
 * assertion rather than a judgement.
 */
const standingPose = (overrides: Partial<Record<ClarityJoint, Vec3>> = {}) => {
  const base: Record<ClarityJoint, Vec3> = {
    head: [0, 1.75, 0],
    neck: [0, 1.5, 0],
    leftShoulder: [-0.2, 1.45, 0],
    rightShoulder: [0.2, 1.45, 0],
    leftElbow: [-0.24, 1.15, 0.02],
    rightElbow: [0.24, 1.15, 0.02],
    leftWrist: [-0.26, 0.9, 0.05],
    rightWrist: [0.26, 0.9, 0.05],
    leftHand: [-0.27, 0.82, 0.06],
    rightHand: [0.27, 0.82, 0.06],
    leftHip: [-0.11, 0.95, 0],
    rightHip: [0.11, 0.95, 0],
    leftKnee: [-0.12, 0.52, 0.02],
    rightKnee: [0.12, 0.52, 0.02],
    leftAnkle: [-0.13, 0.08, 0],
    rightAnkle: [0.13, 0.08, 0],
    leftHeel: [-0.13, 0.02, -0.05],
    rightHeel: [0.13, 0.02, -0.05],
    leftToe: [-0.13, 0.01, 0.16],
    rightToe: [0.13, 0.01, 0.16],
  };
  return { ...base, ...overrides };
};

const STANCE_WIDTH = 0.26;

test("the mass cloud carries the whole pot and nothing more", () => {
  const cloud = buildMassCloud(standingPose());
  const total = cloud.reduce((sum, point) => sum + point.units, 0);
  assert.ok(
    Math.abs(total - TOTAL_MASS_UNITS) < 1e-9,
    `cloud carries ${total} units, expected ${TOTAL_MASS_UNITS}`
  );
  assert.equal(cloud.length, MASS_PARCELS.length);
});

test("every mass parcel hangs off joints that exist", () => {
  // A typo in a joint name would place a parcel at undefined and silently
  // produce NaN in the centre of mass.
  for (const parcel of MASS_PARCELS) {
    assert.ok(
      (CLARITY_JOINTS as readonly string[]).includes(parcel.from),
      `parcel ${parcel.label} hangs off unknown joint ${parcel.from}`
    );
    assert.ok(
      (CLARITY_JOINTS as readonly string[]).includes(parcel.to),
      `parcel ${parcel.label} hangs off unknown joint ${parcel.to}`
    );
    assert.ok(parcel.at >= 0 && parcel.at <= 1, `parcel ${parcel.label} sits outside its segment`);
  }
});

test("the upper mass map is the body from the hips up, and excludes the legs", () => {
  const upperLabels = UPPER_PARCELS.map((parcel) => parcel.label);
  for (const excluded of ["thigh-left", "shank-right", "foot-left", "pelvis-left"]) {
    assert.ok(!upperLabels.includes(excluded), `${excluded} must not be in the upper map`);
  }
  for (const included of ["head", "thorax-left", "upperarm-right"]) {
    assert.ok(upperLabels.includes(included), `${included} must be in the upper map`);
  }
});

test("a symmetric stance balances over the middle of the feet", () => {
  const mass = estimateMass({ joints: standingPose(), stanceWidthM: STANCE_WIDTH });

  assert.ok(Math.abs(mass.upperMassGround[0]) < 1e-6, "upper mass should be centred on X");
  assert.ok(Math.abs(mass.supportCentre[0]) < 1e-6, "support should be centred on X");
  assert.equal(mass.upperMassGround[1], 0, "the ground projection must be on the ground");
  assert.equal(mass.supportCentre[1], 0, "support must be on the ground");
  assert.ok(Math.abs(mass.normalisedSeparation) < 1e-6, "balanced stance has no separation");
  assert.ok(Math.abs(mass.footShare.left - 0.5) < 1e-6);
  assert.ok(Math.abs(mass.footShare.right - 0.5) < 1e-6);
});

test("the upper mass centre sits above the ground, at torso height", () => {
  const mass = estimateMass({ joints: standingPose(), stanceWidthM: STANCE_WIDTH });
  // Upper body mass for a 1.8m figure should land around chest height. This
  // is a sanity band, not a precision claim.
  assert.ok(
    mass.upperMassCentre[1] > 1.05 && mass.upperMassCentre[1] < 1.45,
    `upper mass centre at Y=${mass.upperMassCentre[1]} is not plausibly mid-torso`
  );
});

test("leaning right moves upper mass right and loads the right foot", () => {
  const leaned = standingPose({
    head: [0.3, 1.73, 0],
    neck: [0.26, 1.49, 0],
    leftShoulder: [0.06, 1.44, 0],
    rightShoulder: [0.46, 1.44, 0],
    leftHip: [0.02, 0.95, 0],
    rightHip: [0.24, 0.95, 0],
  });
  const mass = estimateMass({ joints: leaned, stanceWidthM: STANCE_WIDTH });

  assert.ok(mass.upperMassGround[0] > 0.05, "upper mass should have moved right");
  assert.ok(
    mass.footShare.right > mass.footShare.left,
    `right foot should carry more: got L=${mass.footShare.left} R=${mass.footShare.right}`
  );
  assert.ok(
    Math.abs(mass.footShare.left + mass.footShare.right - 1) < 1e-9,
    "foot shares must sum to one"
  );
});

test("support is constrained into the feet even when the mass is not", () => {
  // The plan's rule: the upper mass map need not land under either foot, but
  // the support estimate must terminate within the support geometry. This is
  // that rule as an assertion.
  const extreme = standingPose({
    head: [1.4, 1.6, 0],
    neck: [1.2, 1.4, 0],
    leftShoulder: [1.0, 1.4, 0],
    rightShoulder: [1.4, 1.4, 0],
    leftHip: [0.8, 0.95, 0],
    rightHip: [1.0, 0.95, 0],
  });
  const mass = estimateMass({ joints: extreme, stanceWidthM: STANCE_WIDTH });

  assert.ok(
    mass.upperMassGround[0] > 0.5,
    "the upper mass map is allowed to fall well outside the feet"
  );

  const rightmostFoot = Math.max(extreme.rightHeel[0], extreme.rightToe[0]);
  assert.ok(
    mass.supportCentre[0] <= rightmostFoot + 1e-6,
    `support at X=${mass.supportCentre[0]} escaped the feet (rightmost foot X=${rightmostFoot})`
  );
  assert.ok(mass.normalisedSeparation > 1, "a big lean should show a large normalised separation");
});

test("a lifted heel shrinks the support polygon onto the toes", () => {
  const flat = estimateMass({ joints: standingPose(), stanceWidthM: STANCE_WIDTH });
  assert.equal(flat.supportPolygon.length >= 3, true, "a flat stance gives a real polygon");

  const heelsUp = standingPose({
    leftHeel: [-0.13, 0.18, -0.05],
    rightHeel: [0.13, 0.18, -0.05],
  });
  const lifted = estimateMass({ joints: heelsUp, stanceWidthM: STANCE_WIDTH });

  // Only the two toes remain in contact, so the polygon collapses to the toe
  // line and support can no longer sit behind it.
  assert.equal(lifted.supportPolygon.length, 2, "two contact points give a segment, not an area");
  const toeZ = heelsUp.leftToe[2];
  assert.ok(
    Math.abs(lifted.supportCentre[2] - toeZ) < 1e-6,
    `support should be pinned to the toe line at Z=${toeZ}, got Z=${lifted.supportCentre[2]}`
  );
});

test("both feet airborne means no support claim at all", () => {
  const airborne = standingPose({
    leftHeel: [-0.13, 0.4, -0.05],
    rightHeel: [0.13, 0.4, -0.05],
    leftToe: [-0.13, 0.38, 0.16],
    rightToe: [0.13, 0.38, 0.16],
  });
  const mass = estimateMass({ joints: airborne, stanceWidthM: STANCE_WIDTH });

  assert.equal(mass.supportPolygon.length, 0);
  assert.equal(mass.confidence, 0, "no contact means no confidence in a support estimate");
  // An even split here is the absence of a claim, not a claim of balance.
  assert.equal(mass.footShare.left, 0.5);
  assert.equal(mass.footShare.right, 0.5);
});

test("mass confidence follows the confidence of the geometry it was built on", () => {
  const joints = standingPose();
  const allObserved = Object.fromEntries(
    CLARITY_JOINTS.map((joint) => [joint, 1])
  ) as Record<ClarityJoint, number>;
  const allReconstructed = Object.fromEntries(
    CLARITY_JOINTS.map((joint) => [joint, 0.1])
  ) as Record<ClarityJoint, number>;

  const strong = estimateMass({
    joints,
    stanceWidthM: STANCE_WIDTH,
    jointSupport: allObserved,
  });
  const weak = estimateMass({
    joints,
    stanceWidthM: STANCE_WIDTH,
    jointSupport: allReconstructed,
  });

  assert.ok(
    strong.confidence > weak.confidence,
    `observed geometry (${strong.confidence}) should beat reconstructed (${weak.confidence})`
  );
  assert.ok(strong.confidence > 0.9, "a fully observed, fully planted pose should score high");
});

test("convexHullXZ wraps its points and drops interior ones", () => {
  const square: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
    [0.5, 0, 0.5],
  ];
  const hull = convexHullXZ(square);
  assert.equal(hull.length, 4, "the interior point should be dropped");
  for (const point of hull) {
    assert.ok(
      !(Math.abs(point[0] - 0.5) < 1e-9 && Math.abs(point[2] - 0.5) < 1e-9),
      "the interior point is in the hull"
    );
  }
});

test("convexHullXZ survives collinear points", () => {
  const line: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
  ];
  const hull = convexHullXZ(line);
  assert.ok(hull.length >= 2, "collinear points still bound a segment");
});

test("constrainToPolygonXZ leaves interior points alone and pulls outsiders in", () => {
  const square: Vec3[] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, 1],
    [0, 0, 1],
  ];
  const inside = constrainToPolygonXZ([0.5, 0, 0.5], square);
  assert.deepEqual(inside, [0.5, 0, 0.5]);

  const outside = constrainToPolygonXZ([5, 0, 0.5], square);
  assert.ok(Math.abs(outside[0] - 1) < 1e-9, `expected clamp to X=1, got ${outside[0]}`);
  assert.ok(Math.abs(outside[2] - 0.5) < 1e-9);

  // An empty polygon cannot constrain anything; the point passes through,
  // projected to the ground.
  assert.deepEqual(constrainToPolygonXZ([3, 2, 4], []), [3, 0, 4]);
});
