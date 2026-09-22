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
 */

import type { ClarityJoint, ProvenanceSource, Unit, Vec3 } from "../../contracts";
import {
  add,
  boneKey,
  cross,
  distance,
  dot,
  normalise,
  qFromUnitVectors,
  qRotate,
  scale,
  sub,
} from "../../contracts";
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
  /** Why a side could not be leashed at all, or null when it was. */
  readonly skipped: Readonly<Record<FootSide, string | null>>;
}

/** The part of a reconstruction cell this stage reads and writes. */
export interface LeashCell {
  position: Vec3;
  source: ProvenanceSource;
  trust: Unit;
  correctionM: number;
}

export interface FootLeashInput {
  readonly cells: Readonly<Record<ClarityJoint, LeashCell[]>>;
  /** Raw observations, for the reference stance. */
  readonly tracks: Tracks;
  readonly model: MeasuredBodyModel;
  readonly heightM: number;
  readonly anchorFrameIndex: number;
  readonly fps: number;
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
}

const DEFAULTS = {
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
const nudge = (cell: LeashCell, position: Vec3, minTrust: Unit, noticeableM: number) => {
  const movedM = distance(cell.position, position);
  const source =
    cell.source === "observed" && movedM > noticeableM ? "constrained" : cell.source;
  place(cell, position, source, Math.max(cell.trust, minTrust));
};

/**
 * A point at a fixed distance from each of two others, nearest a third.
 *
 * The set of such points is a circle -- where a sphere of `farM` about
 * `far` meets a sphere of `nearM` about `near` -- and `preferred` picks the
 * point on it. This is the heel-up ankle (tibia length from the knee, foot
 * length from the toe), and it is also how the reference foot is made
 * consistent with the body model's bone lengths.
 *
 * If the spheres do not meet the far point is out of reach, and for the
 * ankle the caller has already decided the foot is free; this only has to
 * cope with the far point being too CLOSE, which a real leg cannot do and
 * noise occasionally can.
 */
const pointOnArc = (
  far: Vec3,
  near: Vec3,
  farM: number,
  nearM: number,
  preferred: Vec3
): Vec3 => {
  const toFar = sub(far, near);
  const d = distance(far, near);
  if (d < 1e-6) return add(near, [0, nearM, 0]);
  const axis = scale(toFar, 1 / d);

  // Spheres that do not meet: too close, or the far point out of reach while
  // the caller is still deciding the foot is free. Either way the nearest
  // the point can get is straight along the line between them.
  if (d <= Math.abs(farM - nearM) || d >= farM + nearM) {
    return add(near, scale(axis, nearM));
  }

  const along = (nearM * nearM - farM * farM + d * d) / (2 * d);
  const radius = Math.sqrt(Math.max(0, nearM * nearM - along * along));
  const centre = add(near, scale(axis, along));

  // The direction on the circle nearest the preferred point.
  const offset = sub(preferred, centre);
  let radial = sub(offset, scale(axis, dot(offset, axis)));
  if (dot(radial, radial) < 1e-10) {
    // Preferred point sits on the axis: fall back to "as high as possible",
    // which is where a lifted heel puts an ankle.
    const up: Vec3 = [0, 1, 0];
    radial = sub(up, scale(axis, dot(up, axis)));
    if (dot(radial, radial) < 1e-10) radial = cross(axis, [1, 0, 0]);
  }
  return add(centre, scale(normalise(radial), radius));
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

    const tibiaM = tibia.lengthM;
    const footM = distance(refAnkle, refToe);
    const toleranceM = Math.max(heightM * slackFraction, 2 * tibia.spreadM);
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
      const kneeAt = kneeCell.position;
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
          nudge(ankleCell, placedAnkle, 0.6, noticeableM);
          nudge(cells[heel][index], placedHeel, 0.6, noticeableM);
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

  return { states, feetAnchored, heelReleases, footReleases, skipped };
};
