/**
 * The foot leash: the first Clarity world anchor.
 *
 * WHAT IT REPLACES
 *
 * The anchoring in `observe/` pins the WORLD -- one rotation, one ground, one
 * origin for the clip -- and then slides each frame so the feet it believes
 * are planted land on their reference. Whether a foot is planted is decided
 * by looking at the foot itself: heel height against toe height, per frame.
 * Down the line that is the least reliable measurement in the whole body,
 * because the stance runs along the camera's depth axis and a detector's
 * depth is a guess. The foot flickers between planted and not, and the body
 * above it inherits every flicker as a lean.
 *
 * WHAT IT ASSUMES INSTEAD
 *
 * A foot stays where it was until something that IS well measured proves it
 * cannot. The knee is that something: it is large, tracked in the image
 * plane, and joined to the ankle by a bone of fixed length. So the foot is
 * held at its reference, and the detector's own reading of that foot is
 * ignored -- not averaged in, ignored -- until the knee pulls the tibia
 * taut. Then, and only then, the foot is released, and only along the path a
 * foot can physically take.
 *
 * TWO LEVELS, BECAUSE THAT IS HOW A FOOT LEAVES THE GROUND
 *
 *   planted   Ankle, heel and toe all at their reference.
 *
 *   heel-up   The tibia is taut against the anchored ankle. The ankle is
 *             released onto the arc it can reach while the toe stays down:
 *             the intersection of "tibia length from the knee" and "foot
 *             length from the toe". The detector's ankle is consulted only to
 *             pick a point on that circle. The heel follows rigidly.
 *
 *   free      Even that arc cannot satisfy the tibia: the foot has genuinely
 *             left the ground -- a step, or a trail foot rolling over in the
 *             finish. The detector's readings stand.
 *
 * Heel before toe is not a rule about golf. It falls out of the geometry:
 * the ankle's arc about the toe is the only release that keeps the foot on
 * the ground, so it is tried first.
 *
 * WHY THE RELEASE CANNOT FIRE FROM NOISE
 *
 * A taut tibia is a kinematic necessity, not a threshold on a noisy number:
 * if the knee really is further from the ankle than the shin is long, the
 * ankle has moved. But the knee's own depth is a guess too, so a single bad
 * knee frame could look like a taut tibia. Two guards: the tibia must be
 * taut by more than the body model's own uncertainty in its length, and it
 * must stay taut for more than one frame. Re-planting needs neither -- going
 * slack means the anchored position is reachable again, and holding is the
 * safe default.
 *
 * WHAT THE REFERENCE IS
 *
 * The stance at address: each foot landmark's median over a short window
 * around the anchor frame. Not the flat-footed frames the world anchor
 * chose, because judging flatness is the thing this stage exists to stop
 * relying on.
 *
 * BOTH FEET ON ONE FLOOR
 *
 * At address the golfer is standing on the ground, and the ground is flat.
 * Neither can be proved from a down-the-line clip -- the stance runs along
 * the lens, where the detector's depth is a guess -- and that is exactly why
 * it is assumed rather than left to the guess: a far foot placed 40mm up in
 * the air is not a measurement, it is depth error wearing a height.
 *
 * So the worse-seen foot is set on the better-seen one's floor. Not lifted
 * straight down: moved along its own line of sight, so it stays on the pixel
 * the detector found it at and only its depth -- the guessed part -- gives.
 * But only a little of it: the rest of the leg does not follow, so a long
 * slide down a shallow line of sight walks the foot out from under its own
 * knee, the tibia goes taut and the leash lets the foot go. Past a
 * twentieth of height, the move is made straight down.
 * Sole height is compared heel-and-toe against heel-and-toe, so the
 * detector's heel riding up on the calcaneus is the same on both feet and
 * cancels. Where the line of sight is too flat to meet the floor within a
 * plausible distance, the foot is set down vertically instead: the floor is
 * the assumption, and the pixel yields to it.
 */

import type { ClarityJoint, ConstraintCause, ProvenanceSource, Unit, Vec3 } from "../../contracts";
import {
  add,
  boneKey,
  distance,
  normalise,
  qFromUnitVectors,
  qRotate,
  scale,
  sub,
} from "../../contracts";
import { pointOnArc } from "./arc";
import type { MeasuredBodyModel } from "./bodyModel";
import { medianOf, type Tracks } from "./tracks";

export type FootPhase = "planted" | "heel-up" | "free";

export interface FootState {
  readonly phase: FootPhase;
  /**
   * How far the knee sits beyond the tibia's reach of the ANCHORED ankle,
   * metres. Positive is taut; negative is slack. The one number the release
   * turns on, kept so it can be read off the timeline.
   */
  readonly tautM: number;
}

export type FootSide = "left" | "right";

export interface FootLeashReport {
  readonly states: Readonly<Record<FootSide, readonly FootState[]>>;
  /** Frames on which a foot was held fully at its reference. */
  readonly feetAnchored: number;
  readonly heelReleases: number;
  readonly footReleases: number;
  /**
   * How far the worse-seen foot was moved to stand on the other's floor,
   * metres, and how: along its line of sight, or straight down. Null side
   * when there was no second foot to share a floor with.
   */
  readonly grounded: {
    readonly side: FootSide | null;
    readonly movedM: number;
    readonly along: "sight" | "vertical" | null;
  };
  /** Why a side could not be leashed at all, or null when it was. */
  readonly skipped: Readonly<Record<FootSide, string | null>>;
}

/** The part of a reconstruction cell this stage reads and writes. */
export interface LeashCell {
  position: Vec3;
  source: ProvenanceSource;
  trust: Unit;
  correctionM: number;
  constrainedBy?: ConstraintCause;
}

export interface FootLeashInput {
  readonly cells: Readonly<Record<ClarityJoint, LeashCell[]>>;
  /** Raw observations, for the reference stance. */
  readonly tracks: Tracks;
  readonly model: MeasuredBodyModel;
  readonly heightM: number;
  readonly anchorFrameIndex: number;
  readonly fps: number;
  /** Camera centre per frame, world metres; null where none was fitted. */
  readonly cameras?: readonly (Vec3 | null)[];
  /**
   * Phases already decided by an earlier pass. When given, the state machine
   * is skipped and only the positions are re-applied -- so a second
   * application after smoothing pins the same frames the first one did.
   */
  readonly phases?: Readonly<Record<FootSide, readonly FootPhase[]>>;
}

export interface FootLeashOptions {
  /** Seconds either side of the anchor frame the reference stance is read over. */
  readonly referenceWindowSeconds?: number;
  /** Consecutive taut frames before a release. */
  readonly releaseFrames?: number;
  /**
   * Slack allowed in the tibia before it counts as taut, as a fraction of
   * height. Widened by the body model's own spread on that bone.
   */
  readonly slackFraction?: number;
  /**
   * How close the detector's toe must come to the reference before a FREE
   * foot is taken to have come back to it, as a fraction of height.
   */
  readonly replantFraction?: number;
  readonly minBoneConfidence?: number;
  /**
   * Furthest the far foot may travel along its line of sight to reach the
   * floor, as a fraction of height. Beyond it the ray is too flat to trust.
   */
  readonly maxGroundTravelFraction?: number;
}

const DEFAULTS = {
  maxGroundTravelFraction: 0.05,
  referenceWindowSeconds: 0.25,
  releaseFrames: 2,
  slackFraction: 0.005,
  replantFraction: 0.07,
  minBoneConfidence: 0.35,
} as const;

const SIDES: readonly {
  readonly side: FootSide;
  readonly knee: ClarityJoint;
  readonly ankle: ClarityJoint;
  readonly heel: ClarityJoint;
  readonly toe: ClarityJoint;
}[] = [
  { side: "left", knee: "leftKnee", ankle: "leftAnkle", heel: "leftHeel", toe: "leftToe" },
  { side: "right", knee: "rightKnee", ankle: "rightAnkle", heel: "rightHeel", toe: "rightToe" },
];

/** Median position of a joint over a frame window, or null if never seen there. */
const medianPosition = (
  tracks: Tracks,
  joint: ClarityJoint,
  from: number,
  to: number
): Vec3 | null => {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let index = from; index <= to; index += 1) {
    const sample = tracks[joint].samples[index];
    if (!sample) continue;
    xs.push(sample.position[0]);
    ys.push(sample.position[1]);
    zs.push(sample.position[2]);
  }
  if (xs.length === 0) return null;
  return [medianOf(xs), medianOf(ys), medianOf(zs)];
};

/** Move a cell, keeping the books. */
const place = (cell: LeashCell, position: Vec3, source: ProvenanceSource, trust: Unit) => {
  cell.correctionM += distance(cell.position, position);
  cell.position = position;
  cell.source = source;
  cell.trust = trust;
};

/**
 * Move a seen joint by geometry, on the constraint solver's own rule: a
 * nudge inside detection noise leaves it "observed"; a real move marks it
 * "constrained". A joint nobody saw keeps whatever source it had.
 */
const nudge = (
  cell: LeashCell,
  position: Vec3,
  minTrust: Unit,
  noticeableM: number,
  cause: Omit<ConstraintCause, "movedM" | "share">
) => {
  const movedM = distance(cell.position, position);
  const source =
    cell.source === "observed" && movedM > noticeableM ? "constrained" : cell.source;
  place(cell, position, source, Math.max(cell.trust, minTrust));
  if (source === "constrained" && movedM > (cell.constrainedBy?.movedM ?? 0)) {
    cell.constrainedBy = { ...cause, share: 1, movedM };
  }
};

export const applyFootLeash = (
  input: FootLeashInput,
  options: FootLeashOptions = {}
): FootLeashReport => {
  const windowSeconds = options.referenceWindowSeconds ?? DEFAULTS.referenceWindowSeconds;
  const releaseFrames = options.releaseFrames ?? DEFAULTS.releaseFrames;
  const slackFraction = options.slackFraction ?? DEFAULTS.slackFraction;
  const replantFraction = options.replantFraction ?? DEFAULTS.replantFraction;
  const minBoneConfidence = options.minBoneConfidence ?? DEFAULTS.minBoneConfidence;

  const { cells, tracks, model, heightM, fps } = input;
  const frameCount = tracks.leftAnkle.samples.length;
  const halfWindow = Math.max(1, Math.round(fps * windowSeconds));
  const windowFrom = Math.max(0, input.anchorFrameIndex - halfWindow);
  const windowTo = Math.min(frameCount - 1, input.anchorFrameIndex + halfWindow);
  const replantRadiusM = heightM * replantFraction;
  const noticeableM = heightM * 0.01;

  const states: Record<FootSide, FootState[]> = { left: [], right: [] };
  const skipped: Record<FootSide, string | null> = { left: null, right: null };
  let feetAnchored = 0;
  let heelReleases = 0;
  let footReleases = 0;

  interface Reference {
    readonly tibiaM: number;
    readonly tibiaSpreadM: number;
    ankle: Vec3;
    heel: Vec3;
    toe: Vec3;
    /** Sole height off the raw medians, before squaring moved anything. */
    readonly soleY: number;
  }
  const references: Partial<Record<FootSide, Reference>> = {};

  for (const { side, knee, ankle, heel, toe } of SIDES) {
    const tibia = model.bones[boneKey({ from: knee, to: ankle, structure: "feet", rigid: true })];
    if (!tibia || tibia.lengthM < 1e-4 || tibia.confidence < minBoneConfidence) {
      skipped[side] = "tibia length not measured well enough to leash against";
    }

    const rawAnkle = medianPosition(tracks, ankle, windowFrom, windowTo);
    const rawHeel = medianPosition(tracks, heel, windowFrom, windowTo);
    const refToe = medianPosition(tracks, toe, windowFrom, windowTo);
    if (!skipped[side] && (!rawAnkle || !rawHeel || !refToe)) {
      skipped[side] = "foot not seen around the anchor frame, so there is no reference stance";
    }

    if (skipped[side] || !tibia || !rawAnkle || !rawHeel || !refToe) {
      states[side] = Array.from({ length: frameCount }, () => ({ phase: "free", tautM: 0 }));
      continue;
    }

    /*
     * The reference foot is squared with the body model before it is used.
     *
     * A median taken coordinate by coordinate is not a median foot: noise
     * inflates the distances between the medians, so the foot came out 13mm
     * long on an 83mm segment and the constraint solver then fought the
     * anchor on every frame. The toe stays where the median put it; the
     * ankle and heel keep their directions but take the model's lengths.
     */
    const measured = (from: ClarityJoint, to: ClarityJoint): number | null => {
      const bone = model.bones[boneKey({ from, to, structure: "feet", rigid: true })];
      return bone && bone.lengthM > 1e-4 && bone.confidence >= minBoneConfidence
        ? bone.lengthM
        : null;
    };
    const ankleToeM = measured(ankle, toe);
    const ankleHeelM = measured(ankle, heel);
    const heelToeM = measured(heel, toe);
    const refAnkle = ankleToeM
      ? add(refToe, scale(normalise(sub(rawAnkle, refToe)), ankleToeM))
      : rawAnkle;
    const refHeel =
      ankleHeelM && heelToeM ? pointOnArc(refAnkle, refToe, ankleHeelM, heelToeM, rawHeel) : rawHeel;

    references[side] = {
      tibiaM: tibia.lengthM,
      tibiaSpreadM: tibia.spreadM,
      ankle: refAnkle,
      heel: refHeel,
      toe: refToe,
      soleY: (rawHeel[1] + refToe[1]) / 2,
    };
  }

  const { shift: groundShift, ...grounded } = groundFarFoot(
    references,
    tracks,
    windowFrom,
    windowTo,
    input.cameras?.[input.anchorFrameIndex] ?? null,
    heightM * (options.maxGroundTravelFraction ?? DEFAULTS.maxGroundTravelFraction)
  );

  for (const { side, knee, ankle, heel, toe } of SIDES) {
    const reference = references[side];
    if (!reference) continue;
    const { tibiaM, ankle: refAnkle, heel: refHeel, toe: refToe } = reference;
    const footM = distance(refAnkle, refToe);
    const toleranceM = Math.max(heightM * slackFraction, 2 * reference.tibiaSpreadM);
    const reachM = tibiaM + footM + toleranceM;
    const given = input.phases?.[side];

    let phase: FootPhase = "planted";
    let tautRun = 0;
    let freeRun = 0;
    let lastAnkle: Vec3 = refAnkle;
    const sideStates: FootState[] = [];

    for (let index = 0; index < frameCount; index += 1) {
      const kneeCell = cells[knee][index];
      const kneeKnown = kneeCell.source !== "missing";
      /*
       * The far knee is judged with the foot's correction applied: whatever
       * depth error lifted the foot off the floor lifted the shin above it
       * too, and a knee left up there would read as a taut tibia and release
       * the very foot that was just set down.
       */
      const kneeAt = side === grounded.side ? add(kneeCell.position, groundShift) : kneeCell.position;
      const tautM = kneeKnown ? distance(kneeAt, refAnkle) - tibiaM : 0;

      if (given) {
        phase = given[index] ?? phase;
      } else if (kneeKnown) {
        // A knee nobody located says nothing about the foot: hold the phase.
        switch (phase) {
          case "planted":
            tautRun = tautM > toleranceM ? tautRun + 1 : 0;
            if (tautRun >= releaseFrames) {
              phase = "heel-up";
              heelReleases += 1;
              tautRun = 0;
            }
            break;
          case "heel-up":
            if (tautM <= toleranceM) {
              phase = "planted";
              freeRun = 0;
            } else {
              freeRun = distance(kneeAt, refToe) > reachM ? freeRun + 1 : 0;
              if (freeRun >= releaseFrames) {
                phase = "free";
                footReleases += 1;
                freeRun = 0;
              }
            }
            break;
          case "free": {
            const toeCell = cells[toe][index];
            const toeBack =
              toeCell.source === "observed" && distance(toeCell.position, refToe) <= replantRadiusM;
            if (toeBack && distance(kneeAt, refToe) <= reachM) phase = "heel-up";
            break;
          }
        }
      }

      sideStates.push({ phase, tautM });

      switch (phase) {
        case "planted":
          place(cells[ankle][index], refAnkle, "anchored", 1);
          place(cells[heel][index], refHeel, "anchored", 1);
          place(cells[toe][index], refToe, "anchored", 1);
          lastAnkle = refAnkle;
          feetAnchored += 1;
          break;
        case "heel-up": {
          const ankleCell = cells[ankle][index];
          const preferred = ankleCell.source === "missing" ? lastAnkle : ankleCell.position;
          const placedAnkle = kneeKnown
            ? pointOnArc(kneeAt, refToe, tibiaM, footM, preferred)
            : lastAnkle;
          // The heel rides with the ankle: rotate the reference foot about
          // the toe by whatever turned the reference ankle onto its new spot.
          const turn = qFromUnitVectors(sub(refAnkle, refToe), sub(placedAnkle, refToe));
          const placedHeel = add(refToe, qRotate(turn, sub(refHeel, refToe)));
          // The knee pulled the tibia taut; that is the whole reason.
          const cause = { by: [knee], rule: `${side} shin length — heel released` };
          nudge(ankleCell, placedAnkle, 0.6, noticeableM, cause);
          nudge(cells[heel][index], placedHeel, 0.6, noticeableM, cause);
          place(cells[toe][index], refToe, "anchored", 1);
          lastAnkle = placedAnkle;
          break;
        }
        case "free":
          // The detector's readings stand. Nothing to place.
          break;
      }
    }

    states[side] = sideStates;
  }

  return { states, feetAnchored, heelReleases, footReleases, grounded, skipped };
};

/** Mean detector visibility of a foot over the reference window. */
const footVisibility = (
  tracks: Tracks,
  joints: readonly ClarityJoint[],
  from: number,
  to: number
): number => {
  let total = 0;
  let count = 0;
  for (const joint of joints) {
    for (let index = from; index <= to; index += 1) {
      total += tracks[joint].samples[index]?.visibility ?? 0;
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
};

/**
 * Set the worse-seen foot's reference on the better-seen one's floor, in
 * place. See "BOTH FEET ON ONE FLOOR" above.
 */
const groundFarFoot = (
  references: Partial<
    Record<FootSide, { ankle: Vec3; heel: Vec3; toe: Vec3; readonly soleY: number }>
  >,
  tracks: Tracks,
  from: number,
  to: number,
  camera: Vec3 | null,
  maxTravelM: number
): FootLeashReport["grounded"] & { readonly shift: Vec3 } => {
  const left = references.left;
  const right = references.right;
  if (!left || !right) return { side: null, movedM: 0, along: null, shift: [0, 0, 0] };

  const [leftSide, rightSide] = SIDES;
  const seen = (s: (typeof SIDES)[number]) =>
    footVisibility(tracks, [s.ankle, s.heel, s.toe], from, to);
  const farSide: FootSide = seen(leftSide) <= seen(rightSide) ? "left" : "right";
  const far = farSide === "left" ? left : right;
  const near = farSide === "left" ? right : left;

  /*
   * Heights off the raw medians. The squared reference is shaped by bone
   * lengths through a direction the detector's depth guessed, so its heel
   * height carries that guess -- and along a shallow line of sight every
   * millimetre of it becomes several of travel.
   */
  const dropM = near.soleY - far.soleY;
  const farSole = scale(add(far.heel, far.toe), 0.5);

  let shift: Vec3 = [0, dropM, 0];
  let along: "sight" | "vertical" = "vertical";
  if (camera) {
    const sight = normalise(sub(farSole, camera));
    if (Math.abs(sight[1]) > 1e-6) {
      const travel = dropM / sight[1];
      if (Math.abs(travel) <= maxTravelM) {
        shift = scale(sight, travel);
        along = "sight";
      }
    }
  }

  far.ankle = add(far.ankle, shift);
  far.heel = add(far.heel, shift);
  far.toe = add(far.toe, shift);
  return {
    side: farSide,
    movedM: Math.sqrt(shift[0] ** 2 + shift[1] ** 2 + shift[2] ** 2),
    along,
    shift,
  };
};
