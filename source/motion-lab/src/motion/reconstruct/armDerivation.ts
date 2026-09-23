/**
 * The far arm, derived from the near one and the clip's own anatomy.
 *
 * THE PROBLEM
 *
 * Down the line, one arm is seen and the other mostly is not. The detector
 * still emits a position for the hidden elbow and hand, but at a confidence
 * so low that Clarity discards it, and the arm becomes a gap -- bridged, or
 * at the start of a clip extrapolated, from whatever it last saw. That is a
 * far worse guess than the anatomy allows, and it looks it: the lead arm
 * floating off the body at address.
 *
 * WHAT THE CLIP ALREADY KNOWS
 *
 * The same arm is seen well enough later in the swing for the body model to
 * have measured its upper arm and forearm. And the two hands are on one
 * grip: on the frames where both were seen confidently, the far hand's
 * offset from the near hand -- measured in the near hand's own frame, so it
 * holds as the club turns -- is a constant this clip has taught us. Two
 * hands on a club is an activity fact, the same class as "the club reaches
 * the ground", not a claim about technique.
 *
 * THE GRIP BUBBLE, NOT A FIXED OFFSET
 *
 * The hands do not sit at one fixed offset from each other: the wrists
 * hinge, and on the fixture the wrist-to-wrist distance runs from 61mm to
 * 125mm through a swing. What IS true is that they stay within reach of
 * each other, because both are on the grip. So the constraint is a bubble:
 * a radius about the near wrist, learned from the frames that saw both
 * hands, that the far wrist may not leave. Inside it, whatever the evidence
 * says stands. Only with no evidence at all is the far hand placed at the
 * bubble's typical offset.
 *
 * WHAT IS DONE, AND FROM WHAT
 *
 *   wrist, hand   A reading or a bridge inside the bubble is kept. One
 *                 outside is pulled to the bubble's edge, on the same
 *                 bearing. With neither, the learned median offset.
 *   elbow         On the circle the two bone lengths fix between the
 *                 shoulder and the wrist. A bridge picks the point on it.
 *                 Anything less -- a weak reading, an extrapolation, nothing
 *                 -- and the point is picked BEHIND THE NEAR ELBOW: see
 *                 below. With no camera to say what "behind" is, the near
 *                 elbow mirrored across the body's midline picks it instead.
 *   shoulder      Left alone; the thorax already holds it.
 *
 * Only on frames where the far joint is poorly known. Where the detector saw
 * it properly, the observation stands -- so on a face-on clip, where both
 * arms are seen, this stage does almost nothing.
 *
 * NOT SEEN IS EVIDENCE: BEHIND THE NEAR ONE
 *
 * An elbow the detector could not find is not somewhere unknown. It is
 * somewhere the camera could not see, and down the line the thing in the
 * way is the near arm. Picking the far elbow on the bone circle from a weak
 * reading -- or a mirror built off a far shoulder that is itself carried --
 * could put it out in open picture, where the detector would have found it
 * had it really been there. The pick card said so: "in plain view".
 *
 * So the pick is made on the near elbow's own line of sight: the same pixel,
 * further from the lens by however far the far shoulder sits behind the near
 * one along that line. That depth is the girdle's, placed before this stage,
 * so it is square alignment until the shoulders prove otherwise -- open them
 * to the camera and the far elbow comes forward with them. Once they are
 * open past forty-five degrees the far shoulder is more beside the near one
 * than behind it, the far arm is out in the picture rather than hidden, and
 * the mirror is used instead. Face on, that is always.
 *
 * The bones still decide. This only chooses which point on the circle; a
 * shoulder and wrist that allow nothing hidden get the nearest they allow.
 *
 * WHICH ARM IS "FAR"
 *
 * Whichever the detector saw worse over the clip, not the golfer's lead
 * side. Handedness is not assumed; the evidence decides.
 */

import type { ClarityJoint, ProvenanceSource, Unit, Vec3 } from "../../contracts";
import { CLARITY_JOINTS, add, boneKey, cross, distance, dot, lerpVec, normalise, scale, sub } from "../../contracts";
import { pointOnArc } from "./arc";
import type { MeasuredBodyModel } from "./bodyModel";
import { hiddenBehind } from "./contextBids";
import { medianOf, type Tracks } from "./tracks";

export type ArmSide = "left" | "right";

export interface ArmDerivationReport {
  /** The arm being derived, or null when neither needed it. */
  readonly farSide: ArmSide | null;
  /** Frames on which each far joint was placed by this stage, beyond confirming what was there. */
  readonly derived: Readonly<Record<"elbow" | "wrist" | "hand", number>>;
  /** Of the derived elbows, how many were picked behind the near one. */
  readonly elbowsBehind: number;
  /** Frames the grip bubble was learned from. */
  readonly gripSamples: number;
  /** How far the far wrist may sit from the near one, metres. */
  readonly gripRadiusM: number;
  readonly skipped: string | null;
}

/** The part of a reconstruction cell this stage reads and writes. */
export interface DerivationCell {
  position: Vec3;
  source: ProvenanceSource;
  trust: Unit;
  correctionM: number;
}

export interface ArmDerivationInput {
  readonly cells: Readonly<Record<ClarityJoint, DerivationCell[]>>;
  readonly tracks: Tracks;
  readonly model: MeasuredBodyModel;
  /** Camera centre per frame, world metres; null where none was fitted. */
  readonly cameras?: readonly (Vec3 | null)[];
}

export interface ArmDerivationOptions {
  /** Trust below which a far joint is derived rather than taken as seen. */
  readonly deriveBelowTrust?: number;
  /** Visibility both hands need on a frame for it to teach the grip offset. */
  readonly gripVisibility?: number;
  readonly minGripSamples?: number;
  readonly minBoneConfidence?: number;
  /** Trust given to a derived joint. Lower than an observation; higher than a bridge. */
  readonly derivedTrust?: number;
  /** Slack added to the learned grip radius, as a fraction of it. */
  readonly bubbleSlack?: number;
}

/** How hidden a weak reading's elbow must sit for the reading to be heard. */
const HIDDEN_ENOUGH_TO_HEAR = 0.5;

const DEFAULTS = {
  deriveBelowTrust: 0.5,
  gripVisibility: 0.5,
  minGripSamples: 8,
  minBoneConfidence: 0.35,
  derivedTrust: 0.5,
  bubbleSlack: 0.15,
} as const;

interface Arm {
  readonly side: ArmSide;
  readonly shoulder: ClarityJoint;
  readonly elbow: ClarityJoint;
  readonly wrist: ClarityJoint;
  readonly hand: ClarityJoint;
}

const ARMS: readonly Arm[] = [
  { side: "left", shoulder: "leftShoulder", elbow: "leftElbow", wrist: "leftWrist", hand: "leftHand" },
  { side: "right", shoulder: "rightShoulder", elbow: "rightElbow", wrist: "rightWrist", hand: "rightHand" },
];

/** Mean detector visibility of an arm over the frames that saw it. */
const armVisibility = (tracks: Tracks, arm: Arm): number => {
  let total = 0;
  let count = 0;
  for (const joint of [arm.elbow, arm.wrist, arm.hand]) {
    for (const sample of tracks[joint].samples) {
      total += sample?.visibility ?? 0;
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
};

/**
 * The near hand's own frame: along the hand, then toward the elbow, then
 * across. A grip offset expressed here stays put while the club swings.
 */
const handFrame = (wrist: Vec3, hand: Vec3, elbow: Vec3): [Vec3, Vec3, Vec3] | null => {
  const along = sub(hand, wrist);
  if (dot(along, along) < 1e-8) return null;
  const e1 = normalise(along);
  const toElbow = sub(elbow, wrist);
  const perpendicular = sub(toElbow, scale(e1, dot(toElbow, e1)));
  if (dot(perpendicular, perpendicular) < 1e-8) return null;
  const e2 = normalise(perpendicular);
  return [e1, e2, cross(e1, e2)];
};

const inFrame = (frame: [Vec3, Vec3, Vec3], offset: Vec3): Vec3 => [
  dot(offset, frame[0]),
  dot(offset, frame[1]),
  dot(offset, frame[2]),
];

const fromFrame = (frame: [Vec3, Vec3, Vec3], local: Vec3): Vec3 =>
  add(add(scale(frame[0], local[0]), scale(frame[1], local[1])), scale(frame[2], local[2]));

/**
 * Move a far joint, keeping the books. A reading or a bridge that the
 * anatomy merely confirmed -- nudged by less than detection noise -- keeps
 * its own provenance: the evidence stood, and saying "derived" would claim
 * more for this stage than it did. Anything moved further, or built from
 * nothing, is derived.
 */
const place = (cell: DerivationCell, position: Vec3, trust: Unit, noticeableM: number) => {
  const movedM = distance(cell.position, position);
  const confirmed =
    (cell.source === "observed" || cell.source === "reconstructed") && movedM <= noticeableM;
  cell.correctionM += movedM;
  cell.position = position;
  if (confirmed) return false;
  cell.source = "derived";
  cell.trust = trust;
  return true;
};

/** Mirror a point across the plane through `on` with the given normal. */
const mirrorAcross = (point: Vec3, on: Vec3, normal: Vec3): Vec3 => {
  const n = normalise(normal);
  const depth = dot(sub(point, on), n);
  return sub(point, scale(n, 2 * depth));
};

/**
 * The point hidden behind `near` from the camera: on its line of sight, as
 * much further out as the far shoulder sits behind the near one.
 *
 * Null unless the far shoulder really is behind the near one -- more of the
 * pair's separation along the line of sight than across it. Face on, the far
 * arm is across the picture, not behind anything, and hiding it would be
 * wrong; the mirror is the better guess there.
 */
const behindNearOne = (
  near: Vec3,
  camera: Vec3,
  nearShoulder: Vec3,
  farShoulder: Vec3
): Vec3 | null => {
  const sight = sub(near, camera);
  const range = Math.sqrt(dot(sight, sight));
  if (range < 1e-6) return null;
  const direction = scale(sight, 1 / range);
  const apart = sub(farShoulder, nearShoulder);
  const depthM = dot(apart, direction);
  const acrossM = distance(apart, scale(direction, depthM));
  if (depthM <= acrossM) return null;
  return add(camera, scale(direction, range + depthM));
};

/** The point, pulled to within `radiusM` of `centre` on its own bearing. */
const intoBubble = (point: Vec3, centre: Vec3, radiusM: number): Vec3 => {
  const d = distance(point, centre);
  if (d <= radiusM) return point;
  return add(centre, scale(sub(point, centre), radiusM / d));
};

export const deriveFarArm = (
  input: ArmDerivationInput,
  options: ArmDerivationOptions = {}
): ArmDerivationReport => {
  const deriveBelow = options.deriveBelowTrust ?? DEFAULTS.deriveBelowTrust;
  const gripVisibility = options.gripVisibility ?? DEFAULTS.gripVisibility;
  const minGripSamples = options.minGripSamples ?? DEFAULTS.minGripSamples;
  const minBoneConfidence = options.minBoneConfidence ?? DEFAULTS.minBoneConfidence;
  const derivedTrust = options.derivedTrust ?? DEFAULTS.derivedTrust;
  const { cells, tracks, model } = input;
  const frameCount = tracks.leftWrist.samples.length;
  const noticeableM = model.estimatedHeightM * 0.01;

  const none = (skipped: string): ArmDerivationReport => ({
    farSide: null,
    derived: { elbow: 0, wrist: 0, hand: 0 },
    elbowsBehind: 0,
    gripSamples: 0,
    gripRadiusM: 0,
    skipped,
  });

  const [left, right] = ARMS;
  const leftSeen = armVisibility(tracks, left);
  const rightSeen = armVisibility(tracks, right);
  const far = leftSeen <= rightSeen ? left : right;
  const near = far === left ? right : left;

  const bubbleSlack = options.bubbleSlack ?? DEFAULTS.bubbleSlack;
  const bone = (from: ClarityJoint, to: ClarityJoint): number | null => {
    const measured = model.bones[boneKey({ from, to, structure: "hands", rigid: true })];
    return measured && measured.lengthM > 1e-4 && measured.confidence >= minBoneConfidence
      ? measured.lengthM
      : null;
  };
  const upperArmM = bone(far.shoulder, far.elbow);
  const forearmM = bone(far.elbow, far.wrist);
  if (!upperArmM || !forearmM) {
    return none("far arm's bones were never measured well enough to derive it");
  }

  /*
   * Learn the grip from the frames that saw both hands properly. Each such
   * frame is a measurement of the same offset, so the median over them is
   * taken per component -- the coordinate-wise median caveat that bit the
   * foot leash does not apply here, because these are components in a
   * frame, not a position whose length matters.
   */
  const wristLocal: Vec3[] = [];
  const handLocal: Vec3[] = [];
  const wristApart: number[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const nearWrist = tracks[near.wrist].samples[index];
    const nearHand = tracks[near.hand].samples[index];
    const nearElbow = tracks[near.elbow].samples[index];
    const farWrist = tracks[far.wrist].samples[index];
    const farHand = tracks[far.hand].samples[index];
    if (!nearWrist || !nearHand || !nearElbow || !farWrist || !farHand) continue;
    const confident = [nearWrist, nearHand, nearElbow, farWrist, farHand].every(
      (sample) => sample.visibility >= gripVisibility
    );
    if (!confident) continue;
    const frame = handFrame(nearWrist.position, nearHand.position, nearElbow.position);
    if (!frame) continue;
    wristLocal.push(inFrame(frame, sub(farWrist.position, nearWrist.position)));
    handLocal.push(inFrame(frame, sub(farHand.position, nearWrist.position)));
    wristApart.push(distance(farWrist.position, nearWrist.position));
  }
  if (wristLocal.length < minGripSamples) {
    return none(`only ${wristLocal.length} frames saw both hands well enough to learn the grip`);
  }
  const medianVec = (values: readonly Vec3[]): Vec3 => [
    medianOf(values.map((value) => value[0])),
    medianOf(values.map((value) => value[1])),
    medianOf(values.map((value) => value[2])),
  ];
  const gripWrist = medianVec(wristLocal);
  const gripHand = medianVec(handLocal);
  /*
   * The bubble's radius: the far wrist was never seen further from the near
   * one than this, give or take detection noise. A high percentile rather
   * than the maximum, so one bad frame cannot inflate it.
   */
  const apartSorted = [...wristApart].sort((a, b) => a - b);
  const gripRadiusM =
    apartSorted[Math.min(apartSorted.length - 1, Math.floor(apartSorted.length * 0.95))] *
    (1 + bubbleSlack);

  const poorlyKnown = (cell: DerivationCell) =>
    cell.source !== "observed" || cell.trust < deriveBelow;

  const derived = { elbow: 0, wrist: 0, hand: 0 };
  let elbowsBehind = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const nearWristCell = cells[near.wrist][index];
    const nearHandCell = cells[near.hand][index];
    const nearElbowCell = cells[near.elbow][index];
    // Nothing to derive from: the near arm is itself unknown this frame.
    if ([nearWristCell, nearHandCell, nearElbowCell].some((cell) => cell.source === "missing")) {
      continue;
    }
    const frame = handFrame(nearWristCell.position, nearHandCell.position, nearElbowCell.position);
    if (!frame) continue;

    const wristCell = cells[far.wrist][index];
    const handCell = cells[far.hand][index];
    const elbowCell = cells[far.elbow][index];

    /*
     * Inside the bubble, evidence stands. A reading or a bridge that has
     * some idea where the hand went is kept, only pulled in if it strayed
     * out of reach; an extrapolation has no idea and is replaced.
     */
    const nearWrist = nearWristCell.position;
    const hasSomeIdea = (cell: DerivationCell) =>
      cell.source === "observed" || cell.source === "reconstructed";

    if (poorlyKnown(wristCell)) {
      const fallback = add(nearWrist, fromFrame(frame, gripWrist));
      const kept = hasSomeIdea(wristCell) ? intoBubble(wristCell.position, nearWrist, gripRadiusM) : fallback;
      if (place(wristCell, kept, derivedTrust, noticeableM)) derived.wrist += 1;
    }
    if (poorlyKnown(handCell)) {
      const fallback = add(nearWrist, fromFrame(frame, gripHand));
      // The hand sits a hand-length beyond the wrist, so its bubble is
      // the wrist's plus that.
      const handReach = gripRadiusM + distance(fromFrame(frame, gripHand), fromFrame(frame, gripWrist));
      const kept = hasSomeIdea(handCell) ? intoBubble(handCell.position, nearWrist, handReach) : fallback;
      if (place(handCell, kept, derivedTrust, noticeableM)) derived.hand += 1;
    }

    if (poorlyKnown(elbowCell)) {
      const shoulderCell = cells[far.shoulder][index];
      if (shoulderCell.source === "missing") continue;
      const shoulder = shoulderCell.position;
      const wrist = wristCell.position;

      /*
       * Who picks the point on the circle. A bridge between two readings
       * knows which way the elbow went and is consulted. Anything less was
       * not seen, and not being seen says where it is: behind the near
       * elbow, on its line of sight, as deep as the far shoulder sits behind
       * the near one. With no camera, or shoulders that leave nothing
       * hidden, the near elbow mirrored across the plane between the
       * shoulders stands in -- both arms hang to the same grip.
       */
      const nearShoulder = cells[near.shoulder][index].position;
      const camera = input.cameras?.[index] ?? null;
      let preferred: Vec3;
      let hidden = false;
      /*
       * A weak reading that would sit hidden is consistent with not having
       * been seen, and is heard. One that would sit in open picture is
       * contradicted by the fact the detector could not find it there.
       */
      const weakButHidden = (): boolean => {
        if (elbowCell.source !== "observed" || !camera) return false;
        const joints = {} as Record<ClarityJoint, Vec3>;
        for (const joint of CLARITY_JOINTS) joints[joint] = cells[joint][index].position;
        joints[far.elbow] = pointOnArc(shoulder, wrist, upperArmM, forearmM, elbowCell.position);
        return (
          hiddenBehind(far.elbow, joints, camera, model.estimatedHeightM).amount >=
          HIDDEN_ENOUGH_TO_HEAR
        );
      };
      if (elbowCell.source === "reconstructed" || weakButHidden()) {
        preferred = elbowCell.position;
      } else {
        const behind = camera
          ? behindNearOne(nearElbowCell.position, camera, nearShoulder, shoulder)
          : null;
        const shoulderMid = lerpVec(shoulder, nearShoulder, 0.5);
        preferred = behind ?? mirrorAcross(nearElbowCell.position, shoulderMid, sub(shoulder, nearShoulder));
        hidden = behind !== null;
      }

      const onArc = pointOnArc(shoulder, wrist, upperArmM, forearmM, preferred);
      if (place(elbowCell, onArc, derivedTrust, noticeableM)) {
        derived.elbow += 1;
        if (hidden) elbowsBehind += 1;
      }
    }
  }

  return { farSide: far.side, derived, elbowsBehind, gripSamples: wristLocal.length, gripRadiusM, skipped: null };
};
