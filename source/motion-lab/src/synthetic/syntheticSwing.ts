/**
 * Synthetic ClarityFrames.
 *
 * Build 1's reason for existing: the 3D Space is built and proved against
 * this, before MediaPipe is wired up at all. If the viewer can play, scrub,
 * switch cameras, draw a skeleton, trail a CBP and colour by provenance using
 * only this file's output, then the visualisation contract is proved and the
 * detector becomes a swappable input rather than a prerequisite.
 *
 * The skeleton is built by forward kinematics from the keyframe schedule, and
 * the arms are solved with the same two-bone IK the Motion Layer uses -- so
 * the wrist cock is a CONSEQUENCE of the hub-to-clubhead radius shortening,
 * not a number anybody typed in. That matters: it means the synthetic body
 * obeys its own bone lengths exactly, which is what makes it a fair test of a
 * constraint solver whose whole job is enforcing bone lengths.
 *
 * Degradation can be injected on top -- dropouts, jumps, noise -- so the
 * debug layers have something to show before the real detector produces the
 * genuine article.
 */

import type {
  BodyModel,
  BodyPose,
  ClarityFrame,
  ClarityJoint,
  ClaritySequence,
  ClarityStructure,
  ClubEstimate,
  ConfidenceComponents,
  FrameProvenance,
  JointProvenance,
  Quat,
  RigidStructure,
  Unit,
  Vec3,
} from "../contracts";
import {
  CLARITY_JOINTS,
  JOINTS_BY_STRUCTURE,
  RIGID_BONES,
  add,
  boneKey,
  clampUnit,
  cross,
  distance,
  lerpVec,
  normalise,
  qFromAxisAngle,
  qFromYawPitchRoll,
  qMultiply,
  qRotate,
  scale,
  solveTwoBone,
  sub,
} from "../contracts";
import { buildFrameConfidence, penalise, PENALTY_SCALES } from "../motion/confidence/confidence";
import { estimateMass } from "../motion/mass/massModel";
import { checkableBodies, checkMassAgainstShape } from "../motion/mass/massSanity";
import { gaussian, makeRng, proportionsForHeight, type Proportions } from "./proportions";
import {
  RIGHT_HANDED_SWING,
  durationSeconds,
  sampleSwing,
  type InterpolatedKey,
  type SwingKey,
} from "./swingKeyframes";

const DEG = Math.PI / 180;

/* ----------------------------- options ------------------------------ */

export interface SyntheticDropout {
  readonly joint: ClarityJoint;
  readonly startFrame: number;
  readonly length: number;
}

export interface SyntheticJump {
  readonly joint: ClarityJoint;
  readonly frame: number;
  readonly offsetM: number;
}

/**
 * Faults to inject.
 *
 * These do NOT change the underlying ground truth -- the body still moves
 * exactly as the schedule says. What changes is the provenance and confidence
 * the frame reports, plus (for jumps and noise) the reported position. That
 * split is deliberate: it lets the 3D Space's honesty layers be tested while
 * the true answer is still known, which is impossible once real video is
 * involved.
 */
export interface SyntheticDegradation {
  /** Gaussian position noise, metres standard deviation. */
  readonly noiseM?: number;
  readonly dropouts?: readonly SyntheticDropout[];
  readonly jumps?: readonly SyntheticJump[];
  /** Frames after which club evidence is lost, so CBP confidence decays. */
  readonly clubLostFromFrame?: number;
}

export interface SyntheticSwingOptions {
  readonly heightM?: number;
  readonly clubLengthM?: number;
  /**
   * Where the balance point sits along the shaft, as a fraction from the grip
   * end. Roughly half-way on a driver. Configurable because the CBP's whole
   * point is that it is a derived quantity, not a detected one.
   */
  readonly cbpFromGripRatio?: number;
  readonly fps?: number;
  readonly seed?: number;
  /** Swing-plane tilt from vertical, degrees. Clamped so the club can reach. */
  readonly planeTiltDeg?: number;
  readonly keys?: readonly SwingKey[];
  readonly degradation?: SyntheticDegradation;
  readonly source?: string;
}

/* --------------------------- swing plane ---------------------------- */

interface SwingPlane {
  /** Unit vector from the hub toward the ball at address. */
  readonly toBall: Vec3;
  /** Unit vector in the plane, toward the trail foot. The backswing direction. */
  readonly alongStance: Vec3;
  readonly normal: Vec3;
  /** Hub-to-clubhead distance at address, metres. */
  readonly addressRadius: number;
  readonly ballPosition: Vec3;
  readonly effectiveTiltDeg: number;
}

/* ------------------------------ pose -------------------------------- */

interface Pose {
  readonly joints: Record<ClarityJoint, Vec3>;
  readonly thorax: RigidStructure;
  readonly pelvis: RigidStructure;
  readonly grip: Vec3;
  readonly clubhead: Vec3;
  readonly cbp: Vec3;
  /** Metres the arm chain was asked to exceed its reach. Should stay ~0. */
  readonly armOverreachM: number;
}

const zeroJoints = (): Record<ClarityJoint, Vec3> =>
  Object.fromEntries(CLARITY_JOINTS.map((joint) => [joint, [0, 0, 0] as Vec3])) as Record<
    ClarityJoint,
    Vec3
  >;

/**
 * Orientation of a torso segment that TURNS ABOUT ITS OWN SPINE.
 *
 * The obvious composition -- yaw about world Y, then pitch forward -- is
 * wrong, and wrong in a way that looks like a tracking fault rather than a
 * modelling one. It tips the body forward in world space and then swings the
 * whole tilted body around a vertical axis, so the direction of the forward
 * lean rotates with the turn. Face-on, at the top of the backswing, the torso
 * appears to have fallen thirty degrees sideways.
 *
 * A golfer does the opposite: the spine holds its posture -- leant forward
 * over the ball, maybe side-bent -- and the shoulders TURN ABOUT THAT AXIS.
 *
 * So the turn is applied innermost, about the body's own vertical, and the
 * posture rotations place the resulting spine in the world. Written as
 * `SideBend . Tilt . Turn`, since `qMultiply(A, B)` means apply B then A.
 */
const spineOrientation = (turn: number, forwardTilt: number, sideBend: number): Quat =>
  qMultiply(
    qFromAxisAngle([0, 0, 1], sideBend),
    qMultiply(qFromAxisAngle([1, 0, 0], forwardTilt), qFromAxisAngle([0, 1, 0], turn))
  );

/**
 * Foot yaw. The lead foot is flared toward the target; the trail foot is near
 * square. Positive yaw turns the toes toward the trail side, so the lead
 * foot's flare is negative.
 */
const FOOT_YAW_DEG: Readonly<Record<"left" | "right", number>> = { left: -18, right: 4 };

interface Foot {
  readonly ankle: Vec3;
  readonly heel: Vec3;
  readonly toe: Vec3;
}

/**
 * A foot, as a rigid body pivoting about the toe.
 *
 * The first version of this moved the heel up and left the ankle where it
 * was, which quietly stretched the ankle-to-heel bone by nine millimetres
 * whenever a heel came off the ground. A foot does not do that. It pivots:
 * the toe stays planted, and the heel AND ankle both swing up about it
 * together.
 *
 * Because every point is placed from one rotation of one rigid local frame,
 * all three foot bones hold their length exactly, at any lift angle, by
 * construction rather than by tuning.
 */
const buildFoot = (side: "left" | "right", key: InterpolatedKey, props: Proportions): Foot => {
  const halfStance = props.stanceWidth / 2;
  const lift = side === "left" ? key.leadHeelLift : key.trailHeelLift;

  const yawQ = qFromYawPitchRoll(FOOT_YAW_DEG[side] * DEG, 0, 0);
  const soleLength = props.toeAhead + props.heelBehind;

  // Heel height is L*sin(pitch), so the schedule's requested lift becomes an
  // angle. Clamped just under vertical: a foot cannot fold past its own sole.
  const pitch = Math.asin(Math.min(0.98, Math.max(0, lift / soleLength)));
  const footQ = qMultiply(yawQ, qFromAxisAngle([1, 0, 0], pitch));

  const toeOffset = qRotate(yawQ, [0, 0, props.toeAhead]);
  const toe: Vec3 = [
    (side === "left" ? -halfStance : halfStance) + toeOffset[0],
    0,
    toeOffset[2],
  ];

  return {
    toe,
    ankle: add(toe, qRotate(footQ, [0, props.ankleY, -props.toeAhead])),
    heel: add(toe, qRotate(footQ, [0, 0, -soleLength])),
  };
};

/**
 * The torso, from the pelvis up. Everything else hangs off this.
 *
 * `hipY` is passed in rather than taken from the proportions because the
 * pelvis has to be FITTED -- see `buildTorso`.
 */
const torsoCore = (key: InterpolatedKey, props: Proportions, hipY: number) => {
  const pelvisCentre: Vec3 = [key.shiftX, hipY, 0];
  // The pelvis tips forward with the spine, but less -- most of the forward
  // lean of a golf posture is hip hinge, which shows up between pelvis and
  // thorax rather than at the pelvis itself.
  const pelvisQ = spineOrientation(key.pelvisYaw * DEG, key.spineTilt * DEG * 0.3, 0);
  const thoraxQ = spineOrientation(
    key.thoraxYaw * DEG,
    key.spineTilt * DEG,
    key.thoraxRoll * DEG
  );

  const spineLength = props.shoulderY - props.hipY;
  const thoraxCentre = add(pelvisCentre, qRotate(thoraxQ, [0, spineLength, 0]));

  const shoulderOffset = qRotate(thoraxQ, [props.shoulderHalfWidth, 0, 0]);
  const hipOffset = qRotate(pelvisQ, [props.hipHalfWidth, 0, 0]);

  // The neck IS the shoulder midpoint, which is `thoraxCentre` by
  // construction. That is not a simplification, it is the only definition a
  // detector can support: BlazePose has no neck landmark, so `observe/`
  // derives the neck as the midpoint of the shoulders. A fixture that placed
  // it a few centimetres higher would be testing the pipeline against a
  // definition the pipeline cannot produce.
  const neck = thoraxCentre;
  // The head stays quieter than the thorax -- it is not rigidly welded to it.
  const headQ = spineOrientation(
    key.thoraxYaw * DEG * 0.35,
    key.spineTilt * DEG * 0.8,
    key.thoraxRoll * DEG * 0.4
  );
  const head = add(neck, qRotate(headQ, [0, props.headY - props.shoulderY, 0]));

  return {
    pelvisCentre,
    pelvisQ,
    thoraxCentre,
    thoraxQ,
    spineLength,
    leftShoulder: sub(thoraxCentre, shoulderOffset),
    rightShoulder: add(thoraxCentre, shoulderOffset),
    leftHip: sub(pelvisCentre, hipOffset),
    rightHip: add(pelvisCentre, hipOffset),
    neck,
    head,
  };
};

/**
 * The torso with its pelvis height fitted to the legs.
 *
 * Standing hip height is only correct when the hips are directly above the
 * feet. Turn the pelvis ninety degrees and shift it toward the lead foot --
 * which is what a finish position IS -- and the hip travels away from its
 * ankle. Hold the pelvis at standing height through that and the leg has to
 * stretch to keep up.
 *
 * So the pelvis drops until both legs fit, which is what actually happens: a
 * wider or more displaced stance sits lower. Without this the femur grows by
 * several millimetres at the finish, and the fixture would be violating the
 * very constraint the Motion Layer exists to enforce.
 */
const buildTorso = (key: InterpolatedKey, props: Proportions) => {
  const leftFoot = buildFoot("left", key, props);
  const rightFoot = buildFoot("right", key, props);
  const leftAnkle = leftFoot.ankle;
  const rightAnkle = rightFoot.ankle;

  // Just inside full extension, so the knee never has to solve at a singularity.
  const legReach = (props.thigh + props.shank) * 0.995;

  let hipY = props.hipY;
  let core = torsoCore(key, props, hipY);

  // Fixed passes, no early exit, for the same reason as the arm fit: an
  // iteration count that depends on the input makes the result discontinuous
  // between adjacent frames.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const excess =
      Math.max(distance(core.leftHip, leftAnkle), distance(core.rightHip, rightAnkle)) - legReach;
    hipY = Math.max(props.kneeY, hipY - Math.max(0, excess) * 1.05);
    core = torsoCore(key, props, hipY);
  }

  return { ...core, leftFoot, rightFoot, leftAnkle, rightAnkle };
};

/**
 * Where each hand grips the club, as a distance from the grip reference point
 * along the shaft. The lead hand is above the trail hand, about 80mm apart,
 * which is a golf grip.
 */
const LEAD_HAND_OFFSET_M = 0.04;
const TRAIL_HAND_OFFSET_M = 0.12;

/** Midpoint of the two, which is what a detector's "hands" resolve to. */
const HANDS_CENTRE_OFFSET_M = (LEAD_HAND_OFFSET_M + TRAIL_HAND_OFFSET_M) / 2;

/**
 * How far the grip sits from the hub -- the midpoint between the shoulders.
 *
 * NOT the arm's length. The arms angle inward to meet on the club, so the
 * hands are closer to the sternum than a fully extended arm would reach. The
 * number that matters is the one that keeps each SHOULDER within reach of its
 * own wrist: the shoulders are offset laterally from the hub, so a hub-to-grip
 * distance equal to the arm length puts the wrist beyond the arm by exactly
 * that lateral offset.
 *
 * Getting this wrong does not throw. It stretches the forearm by a few
 * centimetres every frame, which would quietly invalidate the fixture as a
 * test of a bone-length constraint solver.
 */
const baseArmSpan = (props: Proportions): number => {
  const armReach = maxArmReach(props);
  const perpendicular = Math.sqrt(
    Math.max(0.04, armReach * armReach - props.shoulderHalfWidth * props.shoulderHalfWidth)
  );
  return Math.max(0.2, perpendicular - HANDS_CENTRE_OFFSET_M);
};

/**
 * How far the shoulder is allowed to be from its own wrist.
 *
 * Well inside full extension, and not merely for tidiness. As a two-bone
 * chain straightens, the middle joint's sensitivity to the endpoint distance
 * diverges -- at 97% of reach a millimetre at the wrist moves the elbow by
 * four. Real arms do not straighten to the millimetre, and a fixture that
 * lets them manufactures elbow accelerations no body could produce.
 */
const maxArmReach = (props: Proportions): number => (props.upperArm + props.foreArm) * 0.92;

/**
 * Pin the swing plane using the address posture.
 *
 * The tilt is clamped so the arm-plus-club chain can actually reach the
 * ground. An unreachable radius would make the IK straighten and quietly
 * detach the clubhead from the hands every frame -- which is exactly the
 * artefact the optional 3D club is supposed to reveal, so manufacturing it
 * in the fixture would waste the signal.
 */
const buildSwingPlane = (
  props: Proportions,
  clubLengthM: number,
  requestedTiltDeg: number,
  hub: Vec3
): SwingPlane => {
  const maxReach = baseArmSpan(props) + clubLengthM;

  const maxTiltRad = Math.acos(Math.min(1, hub[1] / (maxReach * 0.97)));
  const tiltRad = Math.min(requestedTiltDeg * DEG, maxTiltRad);

  const toBall: Vec3 = [0, -Math.cos(tiltRad), Math.sin(tiltRad)];
  const alongStance: Vec3 = [1, 0, 0];
  const addressRadius = hub[1] / Math.cos(tiltRad);

  return {
    toBall,
    alongStance,
    normal: normalise(cross(toBall, alongStance)),
    addressRadius,
    ballPosition: add(hub, scale(toBall, addressRadius)),
    effectiveTiltDeg: tiltRad / DEG,
  };
};

const buildPose = (
  key: InterpolatedKey,
  props: Proportions,
  plane: SwingPlane,
  clubLengthM: number,
  cbpRatio: number
): Pose => {
  const joints = zeroJoints();
  const torso = buildTorso(key, props);

  joints.head = torso.head;
  joints.neck = torso.neck;
  joints.leftShoulder = torso.leftShoulder;
  joints.rightShoulder = torso.rightShoulder;
  joints.leftHip = torso.leftHip;
  joints.rightHip = torso.rightHip;

  /* ---- club, from the arc ---- */

  const hub = lerpVec(torso.leftShoulder, torso.rightShoulder, 0.5);
  const theta = key.theta * DEG;
  const radius = plane.addressRadius * key.radius;

  const radial = add(
    scale(plane.toBall, Math.cos(theta)),
    scale(plane.alongStance, Math.sin(theta))
  );
  const tangent = add(
    scale(plane.toBall, -Math.sin(theta)),
    scale(plane.alongStance, Math.cos(theta))
  );
  const clubhead = add(hub, scale(radial, radius));

  /*
   * The hands sit off the hub-to-clubhead chord, and WHICH SIDE matters more
   * than it looks.
   *
   * The first version flipped the side with the direction of travel, on the
   * reasoning that the club trails the hands both going back and coming down.
   * It produced a fixture in which the trail hand oscillated between 0 and
   * 50 m/s on alternating frames near the top: as the pole swings through the
   * chord its perpendicular component passes through zero and the two-bone
   * solve folds through to the mirror configuration, so the grip teleports
   * across. Impossible, and worse, impossible in a way that looked like a
   * tracking fault -- the jump detector flagged eight frames of it before the
   * cause was found.
   *
   * The side is now fixed, which is also the more honest model: a golfer's
   * wrists hinge one way and the club never crosses to the other side of the
   * arms. The tangent is exactly perpendicular to the chord by construction
   * -- the chord IS the radius of the arc -- so this pole can never become
   * degenerate, at any point in the swing.
   */
  const pole = tangent;

  /*
   * The grip sits at a CONSTANT distance from the hub.
   *
   * An earlier version adjusted that distance per frame, shrinking it
   * whenever a shoulder could not reach its own wrist. It was well meant and
   * it was the single worst artefact in the fixture: the correction depended
   * on how many passes the loop happened to take, so the span bounced between
   * adjacent frames, and near impact the shoulder-to-wrist distance collapsed
   * to 37% of reach and sprang back within two frames. Nothing in a body does
   * that.
   *
   * No adjustment is needed at all, because `baseArmSpan` is already chosen so
   * the worst case -- a shoulder offset laterally from the hub, plus the hand
   * offset along the grip -- stays inside 92% of the arm's reach. And the
   * swing plane's tilt is clamped so arm-plus-club can always span the radius.
   * The two constraints are satisfied by construction, which is a much better
   * guarantee than one enforced by iteration.
   */
  const span = Math.max(radius - clubLengthM + 0.005, baseArmSpan(props));
  const gripSolve = solveTwoBone(hub, clubhead, span, clubLengthM, pole);
  const shaft = normalise(sub(clubhead, gripSolve.joint));

  const grip = gripSolve.joint;

  /*
   * THE HANDS ARE FIXED ON THE CLUB. THE WRISTS TAKE UP THE SLACK.
   *
   * An earlier version had it the other way round: the hands slid along the
   * shaft whenever an arm could not reach. That kept every bone exact and
   * quietly broke something more important -- the hands-to-clubhead distance
   * varied by 192mm over the swing, as though the golfer were repeatedly
   * regripping mid-downswing.
   *
   * It matters because that distance is the club model's entire constraint.
   * A detector sees the hands and the clubhead; the club between them is
   * assumed rigid, which is true of real golf and was not true of the
   * fixture. Measuring a club against it came out 90mm short, and the short
   * length then made viewing lines miss the sphere, which lost the depth
   * branch and mirrored the club.
   *
   * So the hands hold the grip at fixed points, and the WRIST is placed 
   * one hand-length back along the line toward its own shoulder -- which is
   * where a forearm actually points, and which buys back that length of
   * reach for free.
   */
  joints.leftHand = add(grip, scale(shaft, LEAD_HAND_OFFSET_M));
  joints.rightHand = add(grip, scale(shaft, TRAIL_HAND_OFFSET_M));

  joints.leftWrist = add(
    joints.leftHand,
    scale(normalise(sub(torso.leftShoulder, joints.leftHand)), props.handLength)
  );
  joints.rightWrist = add(
    joints.rightHand,
    scale(normalise(sub(torso.rightShoulder, joints.rightHand)), props.handLength)
  );

  /* ---- arms ---- */

  for (const side of [-1, 1] as const) {
    const shoulder = side < 0 ? torso.leftShoulder : torso.rightShoulder;
    const wrist = side < 0 ? joints.leftWrist : joints.rightWrist;
    // Elbows fall down, outward and back, in the thorax's own frame.
    const elbowPole = qRotate(torso.thoraxQ, [side * 0.45, -1, -0.4]);
    const solved = solveTwoBone(shoulder, wrist, props.upperArm, props.foreArm, elbowPole);
    if (side < 0) joints.leftElbow = solved.joint;
    else joints.rightElbow = solved.joint;
  }

  /* ---- legs and feet ---- */

  // Lead foot is the left for this right-handed schedule: it is the one on
  // the target side, which is -X. These come from the torso fit rather than
  // being recomputed, so the pelvis and the feet cannot disagree.
  // The toe stays planted while the heel rises; that is what rolling up onto
  // the toe means, and it is what shrinks the support polygon.
  joints.leftAnkle = torso.leftFoot.ankle;
  joints.leftHeel = torso.leftFoot.heel;
  joints.leftToe = torso.leftFoot.toe;
  joints.rightAnkle = torso.rightFoot.ankle;
  joints.rightHeel = torso.rightFoot.heel;
  joints.rightToe = torso.rightFoot.toe;

  for (const side of [-1, 1] as const) {
    const hip = side < 0 ? torso.leftHip : torso.rightHip;
    const ankle = side < 0 ? joints.leftAnkle : joints.rightAnkle;
    const kneePole = qRotate(torso.pelvisQ, [side * 0.3, 0, 1]);
    const solved = solveTwoBone(hip, ankle, props.thigh, props.shank, kneePole);
    if (side < 0) joints.leftKnee = solved.joint;
    else joints.rightKnee = solved.joint;
  }

  /* ---- rigid structures ---- */

  const thorax: RigidStructure = {
    centre: lerpVec(torso.thoraxCentre, torso.pelvisCentre, 0.25),
    orientation: torso.thoraxQ,
    halfExtents: [props.shoulderHalfWidth * 0.85, torso.spineLength * 0.42, props.shoulderHalfWidth * 0.5],
    support: 1,
  };
  const pelvis: RigidStructure = {
    centre: torso.pelvisCentre,
    orientation: torso.pelvisQ,
    halfExtents: [props.hipHalfWidth * 1.5, props.hipHalfWidth * 1.1, props.hipHalfWidth * 0.9],
    support: 1,
  };

  return {
    joints,
    thorax,
    pelvis,
    grip,
    clubhead,
    cbp: add(grip, scale(shaft, cbpRatio * clubLengthM)),
    armOverreachM: gripSolve.overreachM,
  };
};


/* ------------------------- anatomical handedness --------------------- */

/**
 * Mirror the whole scene in X, so the golfer is a possible human.
 *
 * THE BUG THIS FIXES, AND WHY NOTHING CAUGHT IT FOR SO LONG
 *
 * With +X running from the left foot to the right foot and +Y up, a real
 * person's toes point along -(X cross Y), not +(X cross Y). The mnemonic is
 * ENU: East cross Up is SOUTH, so right cross up points BEHIND you.
 *
 * This fixture was built the other way round -- left foot on -X while facing
 * +Z -- which puts the left foot where a real person's right foot goes. It
 * is a mirror image of a human, and `units.ts` documented the same mistake,
 * so the fixture and the contract agreed with each other and every test
 * passed. Real footage does not agree: MediaPipe on a face-on clip put the
 * left ankle at image x 0.595 against the right at 0.398 -- correct for a
 * golfer facing the camera -- and the toes toward the lens. Measured,
 * `dot(R x U, toes)` was +0.993 on the fixture and -0.996 on the real clip.
 *
 * What it cost: every signal whose meaning depends on the fore-aft SIGN --
 * `apparentLeanDeg`, the direction `hipSetBackM` calls "behind", and worst,
 * the sign of the camera-pitch correction -- came out backwards on real
 * video while looking perfect on the fixture.
 *
 * WHY MIRRORING IS THE WHOLE FIX
 *
 * "Left" is a LABEL on a part, not a property of the geometry, and the labels
 * travel with the points. So reflecting the scene leaves the swing's
 * body-relative structure -- which foot leads, which way the backswing goes,
 * which heel lifts -- completely untouched. Only the chirality of the
 * embedding changes, which is precisely what was wrong.
 *
 * WHY IN Z RATHER THAN X
 *
 * Either reflection fixes the chirality; they differ by a 180-degree turn,
 * which is a proper rotation and changes nothing anatomical. Z is the one to
 * use because `anchorSequence` DEFINES +X as left-foot-to-right-foot, so
 * every anchored body -- real or synthetic -- comes out with its left on -X.
 * Reflecting in X would move the fixture's truth to +X and leave the round
 * trip comparing a body against its own 180-degree rotation. Reflecting in Z
 * keeps left on -X and puts the toes on -Z, which is what the real clip
 * measured.
 *
 * Rotations need more than a sign flip. Conjugating a rotation by the
 * reflection diag(1, 1, -1) gives a rotation about the mirrored axis by the
 * NEGATED angle, which for a quaternion (x, y, z, w) is (-x, -y, z, w).
 */
const mirrorVecZ = (v: Vec3): Vec3 => [v[0], v[1], -v[2]];

const mirrorQuatZ = (q: Quat): Quat => [-q[0], -q[1], q[2], q[3]];

const mirrorStructureZ = (structure: RigidStructure): RigidStructure => ({
  ...structure,
  centre: mirrorVecZ(structure.centre),
  orientation: mirrorQuatZ(structure.orientation),
});

const mirrorPoseZ = (pose: Pose): Pose => ({
  ...pose,
  joints: Object.fromEntries(
    Object.entries(pose.joints).map(([joint, position]) => [joint, mirrorVecZ(position)])
  ) as Record<ClarityJoint, Vec3>,
  thorax: mirrorStructureZ(pose.thorax),
  pelvis: mirrorStructureZ(pose.pelvis),
  grip: mirrorVecZ(pose.grip),
  clubhead: mirrorVecZ(pose.clubhead),
  cbp: mirrorVecZ(pose.cbp),
});

/* ------------------------- body model ------------------------------- */

/** Measure the model from a pose, exactly as the real layer measures it from observations. */
const measureBodyModel = (pose: Pose, props: Proportions): BodyModel => {
  const boneLengths: Record<string, number> = {};
  const boneConfidence: Record<string, number> = {};
  for (const bone of RIGID_BONES) {
    boneLengths[boneKey(bone)] = distance(pose.joints[bone.from], pose.joints[bone.to]);
    boneConfidence[boneKey(bone)] = 1;
  }
  return {
    boneLengths,
    boneConfidence,
    estimatedHeightM: props.heightM,
    sampleCount: 1,
  };
};

/* ------------------------- the generator ---------------------------- */

export interface SyntheticSwing extends ClaritySequence {
  /** Where the ball was placed, for a ground marker in the 3D view. */
  readonly ballPosition: Vec3;
  /** The plane tilt actually used after the reachability clamp. */
  readonly planeTiltDeg: number;
  /** Ground truth, before noise and jumps. Lets a test grade a reconstruction. */
  readonly truth: readonly Readonly<Record<ClarityJoint, Vec3>>[];
}

export const generateSyntheticSwing = (
  options: SyntheticSwingOptions = {}
): SyntheticSwing => {
  const heightM = options.heightM ?? 1.8;
  const clubLengthM = options.clubLengthM ?? 1.05;
  const cbpRatio = options.cbpFromGripRatio ?? 0.52;
  const fps = options.fps ?? 60;
  const keys = options.keys ?? RIGHT_HANDED_SWING;
  const degradation = options.degradation ?? {};
  const rng = makeRng(options.seed ?? 20260921);

  const props = proportionsForHeight(heightM);

  // Address posture first, because the swing plane is pinned to it.
  const addressKey = sampleSwing(keys, 0);
  const addressTorso = buildTorso(addressKey, props);
  const addressHub = lerpVec(addressTorso.leftShoulder, addressTorso.rightShoulder, 0.5);
  const plane = buildSwingPlane(props, clubLengthM, options.planeTiltDeg ?? 26, addressHub);

  const duration = durationSeconds(keys);
  const frameCount = Math.max(1, Math.round(duration * fps));
  const dt = 1 / fps;

  const poses: Pose[] = [];
  const truth: Record<ClarityJoint, Vec3>[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const time = index * dt;
    const key = sampleSwing(keys, time);

    // Built in the plane's own axes, then mirrored into anatomically
    // possible ones. See `mirrorPoseX`.
    const pose = mirrorPoseZ(buildPose(key, props, plane, clubLengthM, cbpRatio));
    poses.push(pose);
    truth.push({ ...pose.joints });
  }

  const bodyModel = measureBodyModel(poses[0], props);
  const stanceWidthM = distance(poses[0].joints.leftAnkle, poses[0].joints.rightAnkle);

  const frames = poses.map((pose, index) =>
    assembleFrame({
      index,
      timestampMs: index * dt * 1000,
      pose,
      degradation,
      rng,
      stanceWidthM,
      clubLengthM,
      frameCount,
    })
  );

  return {
    frames,
    fps,
    bodyModel,
    anchor: {
      anchorFrameIndex: 0,
      stanceWidthM,
      anchorIsStable: true,
      // The fixture is built in world axes, so there is no camera to be
      // tilted and nothing to correct -- neither the roll the stance line
      // sees nor the pitch the falling-over boundary does.
      gravityTiltDeg: 0,
      // Measured in the sense that matters: the fixture's own axes ARE the
      // world's, so this zero is a fact rather than a failure to look.
      gravityTiltIsMeasured: true,
      pitchCorrectionDeg: 0,
      pitchCorrectionSource: "none",
      // The fixture places every foot point on the sole, so they all rest on
      // the ground. A real detector's heel landmark does not -- see the note
      // on `footRestHeightM`.
      footRestHeightM: { leftHeel: 0, rightHeel: 0, leftToe: 0, rightToe: 0 },
    },
    /*
     * Run on the fixture as well, where there is no camera to be wrong.
     *
     * Not for the camera's sake -- there isn't one -- but because the reading
     * is a posture measurement too, and running it here is what surfaces this
     * fixture's known flaw: its address leans the spine forward without
     * pushing the hips back, so its mass genuinely sits at about 76% of the
     * foot. Better on the readout than buried in a comment.
     */
    massSanity: (() => {
      const checkable = checkableBodies(frames);
      return checkable.length > 0 ? checkMassAgainstShape(checkable, props.heightM) : null;
    })(),
    confidence: summariseSequence(frames),
    source: options.source ?? "synthetic:right-handed-swing",
    ballPosition: mirrorVecZ(plane.ballPosition),
    planeTiltDeg: plane.effectiveTiltDeg,
    truth,
  };
};

/* ------------------------ frame assembly ---------------------------- */

interface AssembleInput {
  readonly index: number;
  readonly timestampMs: number;
  readonly pose: Pose;
  readonly degradation: SyntheticDegradation;
  readonly rng: () => number;
  readonly stanceWidthM: number;
  readonly clubLengthM: number;
  readonly frameCount: number;
}

const assembleFrame = (input: AssembleInput): ClarityFrame => {
  const { index, pose, degradation, rng } = input;
  const noiseM = degradation.noiseM ?? 0;

  const joints: Record<ClarityJoint, Vec3> = { ...pose.joints };
  const provenanceByJoint = {} as Record<ClarityJoint, JointProvenance>;

  let jumpTotalM = 0;
  let gapTotal = 0;
  let observedCount = 0;

  for (const joint of CLARITY_JOINTS) {
    const dropout = (degradation.dropouts ?? []).find(
      (entry) =>
        entry.joint === joint &&
        index >= entry.startFrame &&
        index < entry.startFrame + entry.length
    );
    const jump = (degradation.jumps ?? []).find(
      (entry) => entry.joint === joint && entry.frame === index
    );

    if (noiseM > 0) {
      joints[joint] = add(joints[joint], [
        gaussian(rng) * noiseM,
        gaussian(rng) * noiseM,
        gaussian(rng) * noiseM,
      ]);
    }

    if (jump) {
      // A jump is applied to the REPORTED position only. The ground truth in
      // `truth` still holds, so a test can measure how well a reconstruction
      // rejected it.
      joints[joint] = add(joints[joint], [jump.offsetM, jump.offsetM * 0.4, 0]);
      jumpTotalM += Math.abs(jump.offsetM);
    }

    if (dropout) {
      const depth = index - dropout.startFrame + 1;
      gapTotal += dropout.length;
      provenanceByJoint[joint] = {
        source: "reconstructed",
        correctionM: 0,
        framesSinceObserved: depth,
        gapLength: dropout.length,
        rawConfidence: 0,
      };
    } else {
      observedCount += 1;
      provenanceByJoint[joint] = {
        source: jump ? "constrained" : "observed",
        correctionM: jump ? Math.abs(jump.offsetM) : 0,
        framesSinceObserved: 0,
        gapLength: 0,
        rawConfidence: clampUnit(0.95 - noiseM * 4),
      };
    }
  }

  const observedFraction = observedCount / CLARITY_JOINTS.length;

  const jointSupport = Object.fromEntries(
    CLARITY_JOINTS.map((joint) => [
      joint,
      provenanceByJoint[joint].source === "observed" ? 1 : 0.35,
    ])
  ) as Record<ClarityJoint, Unit>;

  const club = buildClub(input);

  const components: ConfidenceComponents = {
    directObservation: observedFraction,
    trackingContinuity: penalise(
      CLARITY_JOINTS.length - observedCount,
      PENALTY_SCALES.gapFrames
    ),
    jumpCorrection: penalise(jumpTotalM, PENALTY_SCALES.jumpM),
    gapReconstruction: penalise(gapTotal / CLARITY_JOINTS.length, PENALTY_SCALES.gapFrames),
    bodyConstraintCorrection: penalise(noiseM * 3, PENALTY_SCALES.constraintCorrectionM),
    clubPoint: club.confidence,
  };

  const structures = rollUpStructures(provenanceByJoint, club.confidence);

  const provenance: FrameProvenance = {
    joints: provenanceByJoint,
    observedFraction,
    wholeFrameReconstructed: observedCount === 0,
  };

  return {
    index,
    timestampMs: input.timestampMs,
    body: {
      joints,
      thorax: pose.thorax,
      pelvis: pose.pelvis,
    } satisfies BodyPose,
    club,
    mass: estimateMass({
      joints,
      stanceWidthM: input.stanceWidthM,
      jointSupport,
    }),
    confidence: buildFrameConfidence(components, structures),
    provenance,
  };
};

const buildClub = (input: AssembleInput): ClubEstimate => {
  const { pose, degradation, index } = input;
  const lostFrom = degradation.clubLostFromFrame;
  const headObserved = lostFrom == null || index < lostFrom;
  const framesSinceHeadObserved = headObserved ? 0 : index - lostFrom + 1;

  // When the head is no longer observed, the grip and recent geometry can
  // still support the CBP -- but confidence falls, because the plan is firm
  // that club movement is not invented indefinitely.
  const confidence = headObserved
    ? 0.9
    : clampUnit(0.9 * penalise(framesSinceHeadObserved, PENALTY_SCALES.clubStalenessFrames));

  return {
    cbp: pose.cbp,
    /*
     * The CLUB's grip, not the midpoint of the hands.
     *
     * They are nearly the same and occasionally are not: a hand that had to
     * leave the shaft to stay within its arm's reach would drag a
     * hands-midpoint off the club with it, and the shaft would report a
     * length it does not have. The club is a rigid object with its own
     * geometry; the hands hold it approximately.
     */
    grip: pose.grip,
    head: pose.clubhead,
    lengthM: input.clubLengthM,
    evidence: {
      headObserved,
      gripFromHands: true,
      shaftObserved: headObserved,
      framesSinceHeadObserved,
    },
    confidence,
  };
};

const rollUpStructures = (
  provenance: Record<ClarityJoint, JointProvenance>,
  clubConfidence: Unit
): Record<ClarityStructure, Unit> => {
  const out = {} as Record<ClarityStructure, Unit>;
  for (const [structure, structureJoints] of Object.entries(JOINTS_BY_STRUCTURE) as [
    ClarityStructure,
    readonly ClarityJoint[],
  ][]) {
    if (structure === "club") {
      out.club = clubConfidence;
      continue;
    }
    if (structureJoints.length === 0) {
      out[structure] = 0;
      continue;
    }
    const total = structureJoints.reduce((sum, joint) => {
      const entry = provenance[joint];
      const base = entry.source === "observed" ? entry.rawConfidence : 0.3;
      return sum + base * penalise(entry.correctionM, PENALTY_SCALES.constraintCorrectionM);
    }, 0);
    out[structure] = clampUnit(total / structureJoints.length);
  }
  return out;
};

const summariseSequence = (frames: readonly ClarityFrame[]) => {
  const count = Math.max(1, frames.length);
  const sum = (pick: (frame: ClarityFrame) => number) =>
    frames.reduce((total, frame) => total + pick(frame), 0) / count;

  const components: ConfidenceComponents = {
    directObservation: sum((f) => f.confidence.components.directObservation),
    trackingContinuity: sum((f) => f.confidence.components.trackingContinuity),
    jumpCorrection: sum((f) => f.confidence.components.jumpCorrection),
    gapReconstruction: sum((f) => f.confidence.components.gapReconstruction),
    bodyConstraintCorrection: sum((f) => f.confidence.components.bodyConstraintCorrection),
    clubPoint: sum((f) => f.confidence.components.clubPoint),
  };

  let largestGapFrames = 0;
  let reconstructedFrames = 0;
  for (const frame of frames) {
    if (frame.provenance.observedFraction < 1) reconstructedFrames += 1;
    for (const joint of CLARITY_JOINTS) {
      largestGapFrames = Math.max(largestGapFrames, frame.provenance.joints[joint].gapLength);
    }
  }

  return {
    overall: sum((f) => f.confidence.overall),
    components,
    reconstructedFrameFraction: clampUnit(reconstructedFrames / count),
    largestGapFrames,
  };
};
