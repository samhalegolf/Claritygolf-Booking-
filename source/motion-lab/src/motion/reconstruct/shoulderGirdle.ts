/**
 * The shoulder girdle, fitted as one body rather than two loose points.
 *
 * WHY THIS EXISTS
 *
 * The girdle is about the most rigid thing in the body: two shoulders a
 * fixed distance apart, hung on a ribcage that does not change shape. Until
 * now Clarity knew that only as three bone lengths, and a length is not
 * enough to carry a joint through occlusion. Down the line the far shoulder
 * disappears behind the near one for most of the backswing; the solver will
 * happily put it at exactly the right distance from the near one, in
 * entirely the wrong direction, because a distance is a sphere and nothing
 * said where on that sphere to sit.
 *
 * So the girdle is measured once over the clip as a SHAPE -- corner offsets
 * in its own frame -- and then placed, per frame, by the evidence that frame
 * actually has. A shoulder nobody can see is not guessed at: it is carried
 * there by the corners that were seen.
 *
 * WHAT THE CORNERS ARE, AND WHY THESE FOUR
 *
 *   leftShoulder, rightShoulder   The girdle itself.
 *   head                          The only landmark above the shoulder line.
 *   pelvis                        The hip midpoint -- a virtual corner, and
 *                                 the only landmark below it.
 *
 * The neck is deliberately NOT a corner. `observe/` defines it as the
 * shoulder midpoint, because BlazePose has no neck landmark, so it is not
 * independent evidence about anything -- it is a restatement of the two
 * shoulders, and counting it would be counting them twice. It is written
 * out at the end, as the midpoint of whatever the fit settled on, which
 * also repairs a real fault: with one shoulder occluded the neck used to be
 * bridged on its own and drift off the line it is defined to sit on.
 *
 * Head and pelvis are not rigidly welded to the girdle and nothing here
 * pretends they are. They are included as corners, and how much they count
 * is MEASURED rather than asserted -- see rigidity, below. Both sit close to
 * the girdle's own vertical, so what they pin is its tilt. Neither says
 * anything about its turn, and the fit does not let them: a point on an axis
 * is unmoved by rotation about that axis, so no amount of pelvis evidence
 * can invent a shoulder turn. That is the honest answer. Turn is known from
 * the shoulders and from the arms hanging off them, or it is not known and
 * is carried forward from the last frame that did know it.
 *
 * THE STERNUM, AND THE TWO STRUTS
 *
 * The girdle's own shape is a triangle, not a rod: sternum at the apex, a
 * strut out to each shoulder. The sternum is placed rather than seen -- no
 * detector reports one -- but placing it is what turns three collinear
 * points into a body with an orientation, and it is what the shoulders
 * actually ride on.
 *
 * That changes the KIND of deviation the girdle permits, which is the point
 * of having it. A shoulder is not free to wander in a ball. It is on a strut
 * of fixed length, so the only thing it can do is swing: forward and back,
 * about the sternum, the way a scapula protracts and retracts. The pair's
 * width then follows from the angle -- w(1 - cos(theta)) -- instead of being
 * free alongside it, and a reading that had a shoulder drifting toward the
 * midline is refused rather than absorbed.
 *
 * Both quantities are measured, and they are measured separately because
 * they are not the same kind of thing. The swing is movement and can be
 * degrees. The length is bone and cannot be anything; whatever appears in it
 * is the detector missing the acromion, so it is held to the size of that
 * scatter. Inside both, a corner's own evidence stands untouched. Outside
 * either, it is put back on the strut.
 *
 * THE ALLOWANCE IS MEASURED, NOT CHOSEN
 *
 * On the frames that saw the girdle properly, the template is fitted and the
 * residual recorded. The ninetieth percentile of those residuals is how far
 * that corner was actually seen to wander on this clip, and the same figure
 * decides how much the corner is worth listening to when placing the others.
 * A clip where the head swivels independently of the shoulders -- which is
 * every golf swing -- measures a floppy head and gives it almost no say,
 * without anybody having to write down that a golfer keeps their head still.
 *
 * WHAT NONE OF THIS CAN SEE, AND WHY IT DOES NOT PRETEND TO
 *
 * Scapular travel does not survive into the measurement, and it is worth
 * being exact about why, because the struts make it tempting to read the
 * swing allowance as a measurement of protraction. It is not.
 *
 * ASYMMETRIC travel -- one shoulder forward while the other holds -- is, to
 * these landmarks, the same thing as the whole girdle turning a degree or
 * two further. The fit absorbs it as turn. Nothing separates them without a
 * marker the detector does not have.
 *
 * SYMMETRIC travel -- both forward together -- is mostly a slide of the pair,
 * and the fit absorbs that too, by placing the girdle slightly further
 * forward: head and hips sit on the girdle's own vertical and object only
 * weakly. What is left over is the narrowing, and the narrowing is second
 * order in the angle. Eight degrees of swing moves a shoulder 29mm fore and
 * aft and takes 4mm off the pair's width, which is smaller than the
 * detector's scatter on a shoulder marker.
 *
 * So the allowance these clips measure is detector noise, restated as an
 * angle. What the struts buy is not a protraction reading; it is that the
 * deviation they permit has a physical shape, that a shoulder lost behind
 * the body lands on a sphere of known radius rather than anywhere in a ball,
 * and that the width the model reports follows from the geometry. A test
 * holds this limit visible.
 */

import type {
  ClarityJoint,
  ClarityStructure,
  ProvenanceSource,
  Quat,
  Unit,
  Vec3,
} from "../../contracts";
import {
  add,
  applyRigidFit,
  boneKey,
  clampUnit,
  cross,
  distance,
  dot,
  fitRigidTransform,
  lerpVec,
  normalise,
  qFromAxisAngle,
  qIdentity,
  qRotate,
  scale,
  sub,
  unapplyRigidFit,
  type Correspondence,
  type RigidFit,
} from "../../contracts";
import type { MeasuredBodyModel } from "./bodyModel";
import { medianOf, type Tracks } from "./tracks";

/**
 * Where the sternum sits on the girdle, as a fraction of THIS golfer's
 * measured shoulder width.
 *
 * On the midline, below the line between the shoulder markers, at that
 * line's own depth. Each part of that is a decision worth stating.
 *
 * On the midline and below, because that is the one offset a body plan gives
 * for free and the only one the girdle needs: it puts the third corner off
 * the line the other two share, which is what makes the girdle a triangle
 * with an orientation of its own rather than a rod.
 *
 * At the shoulder line's depth, and NOT forward of it, because no clip can
 * measure how far forward it is and the choice is not cosmetic. A pivot in
 * front of the shoulders and a pivot behind them disagree about whether
 * swinging the shoulders forward makes the pair wider or narrower, and
 * picking one would be asserting the sign of a measurement nobody took. A
 * pivot level with them is the neutral answer: the resting girdle is the
 * widest it gets, and a swing either way narrows it.
 *
 * The fraction is anatomy, in the same class as the 93.5% of standing height
 * the body model uses for the top of the skull: it is scaled by something
 * this golfer was measured for, and it says nothing about golf.
 */
export const STERNUM_BELOW_FRACTION = 0.16;

/** The sternum's offset from the shoulder midpoint, in the girdle's own frame. */
export const sternumOffset = (shoulderWidthM: number): Vec3 => [
  0,
  -STERNUM_BELOW_FRACTION * shoulderWidthM,
  0,
];

export const GIRDLE_CORNERS = ["leftShoulder", "rightShoulder", "head", "pelvis"] as const;
export type GirdleCorner = (typeof GIRDLE_CORNERS)[number];

/** The two corners this stage may actually move. */
const SHOULDERS = ["leftShoulder", "rightShoulder"] as const;
type Shoulder = (typeof SHOULDERS)[number];

const ELBOW_OF: Readonly<Record<Shoulder, ClarityJoint>> = {
  leftShoulder: "leftElbow",
  rightShoulder: "rightElbow",
};

const ARM_OF: Readonly<Record<Shoulder, ClarityStructure>> = {
  leftShoulder: "leftArm",
  rightShoulder: "rightArm",
};

export interface GirdleTemplate {
  /** Each corner's offset in the girdle's own frame, origin at the shoulder midpoint. */
  readonly local: Readonly<Record<GirdleCorner, Vec3>>;
  /** How tightly each corner held that offset over the clip, 0..1. Its say in the fit. */
  readonly rigidity: Readonly<Record<GirdleCorner, Unit>>;
  /** How far each corner was seen to wander from it, metres. Its permitted deviation. */
  readonly allowanceM: Readonly<Record<GirdleCorner, number>>;
  /** Frames each corner was measured from. */
  readonly samples: Readonly<Record<GirdleCorner, number>>;
  /** Shoulder to shoulder, metres. */
  readonly widthM: number;
  /** The sternum's place in the girdle's own frame. */
  readonly sternumLocal: Vec3;
  /** Each strut, sternum out to shoulder, metres. This length does not change. */
  readonly strutM: Readonly<Record<Shoulder, number>>;
  /**
   * How far each strut was seen to swing off the girdle's resting shape,
   * radians. This is the allowance, said in the units the movement happens
   * in: a shoulder does not wander in a ball, it rides forward and back on a
   * bone of fixed length.
   */
  readonly swingRad: Readonly<Record<Shoulder, number>>;
  /**
   * How much each strut's length appeared to change, metres. Bone does not
   * change length, so this is the detector's own scatter on the shoulder
   * marker -- and the stage leaves a reading alone inside it rather than
   * snapping every frame onto an exact sphere and calling noise a violation.
   */
  readonly strutSlackM: Readonly<Record<Shoulder, number>>;
  /** Frames that saw the girdle well enough to measure it at all. */
  readonly sampleCount: number;
}

export interface ShoulderGirdleReport {
  readonly template: GirdleTemplate | null;
  /** Frames on which each shoulder was placed by the girdle rather than by its own evidence. */
  readonly carried: Readonly<Record<Shoulder, number>>;
  /** Frames on which a shoulder's own reading was pulled back inside its allowance. */
  readonly reined: Readonly<Record<Shoulder, number>>;
  /** Frames the fit could not be made at all, for want of any evidence. */
  readonly unfitted: number;
  readonly skipped: string | null;
}

/** The part of a reconstruction cell this stage reads and writes. */
export interface GirdleCell {
  position: Vec3;
  source: ProvenanceSource;
  trust: Unit;
  correctionM: number;
  /**
   * Both are here for the sternum alone. It arrives at this stage looking
   * like a track that was never seen -- because it is one -- and would carry
   * a gap the length of the clip into its provenance and onto the debug
   * panel. A joint that is built rather than tracked was never in a gap, so
   * the stage says so.
   */
  framesSinceObserved: number;
  gapLength: number;
}

export interface ShoulderGirdleInput {
  readonly cells: Readonly<Record<ClarityJoint, GirdleCell[]>>;
  /** Raw observations, for measuring the template. */
  readonly tracks: Tracks;
  readonly model: MeasuredBodyModel;
  /**
   * A template an earlier pass already measured. When given, it is used as
   * is -- so a second application after smoothing fits the same girdle the
   * first one did, rather than re-measuring off its own output.
   */
  readonly template?: GirdleTemplate;
}

export interface ShoulderGirdleOptions {
  /** Detector visibility a corner needs before it may teach the template. */
  readonly measureVisibility?: number;
  /** Frames that must see the girdle before it is worth measuring. */
  readonly minSamples?: number;
  /** Percentile of the fit residual taken as a corner's allowance. */
  readonly allowancePercentile?: number;
  /**
   * Ceiling on an allowance, as a fraction of shoulder width. A clip tracked
   * badly enough to measure more slop than this has not discovered a floppy
   * golfer; it has discovered its own noise, and letting that through would
   * turn the girdle back into two loose points.
   */
  readonly maxAllowanceFraction?: number;
  /** Residual, as a fraction of width, at which a corner counts as fully floppy. */
  readonly floppyFraction?: number;
  /**
   * Ceiling on the swing a strut may be given, radians. A clip that measures
   * more than this has measured its own tracking rather than a scapula: at
   * twenty degrees a shoulder would be free to travel a third of the way to
   * the midline, which no girdle does.
   */
  readonly maxSwingRad?: number;
  /**
   * Ceiling on a strut's length slack, as a fraction of shoulder width.
   *
   * Much tighter than the swing's ceiling, and deliberately so: these are
   * the two halves of the model and they are not the same kind of quantity.
   * A strut is bone and does not get longer, so the only thing that can
   * appear in its length is the detector missing the marker. A clip that
   * measures more than this has not found a stretching collarbone, and
   * letting the number through would turn the strut back into the bubble it
   * replaced -- a shoulder free to drift toward the midline as well as
   * forward and back.
   */
  readonly maxStrutSlackFraction?: number;
  /** Own-evidence weight below which a shoulder gets propped up by its arm. */
  readonly carryBelow?: number;
  /** Trust given to a carried shoulder, before the fit's own evidence scales it. */
  readonly carriedTrust?: number;
  readonly minBoneConfidence?: number;
}

const DEFAULTS = {
  measureVisibility: 0.5,
  minSamples: 8,
  allowancePercentile: 0.9,
  maxAllowanceFraction: 0.2,
  floppyFraction: 0.25,
  maxSwingRad: 20 * (Math.PI / 180),
  maxStrutSlackFraction: 0.03,
  carryBelow: 0.25,
  carriedTrust: 0.55,
  minBoneConfidence: 0.35,
} as const;

/** How much of a joint's reading counts as evidence about where the girdle is. */
const evidenceOf = (cell: GirdleCell): Unit => {
  switch (cell.source) {
    case "observed":
    case "constrained":
    case "anchored":
      return cell.trust;
    // Bridged from both sides, or built from the grip: it knows something,
    // but it is not a sighting of this frame.
    case "reconstructed":
    case "derived":
      return clampUnit(cell.trust * 0.5);
    // An extrapolation is the thing being replaced, and missing is missing.
    default:
      return 0;
  }
};

/**
 * Does this reading have an idea of its own about where the joint went?
 *
 * A sighting does, and so does a bridge between two sightings. An
 * extrapolation does not -- it is a continuation of the last thing seen, and
 * it is exactly what this stage is here to replace. Neither does a joint
 * some stage placed by construction, this one included: treating the girdle's
 * own output as evidence for the girdle would be the fit agreeing with
 * itself.
 */
const hasOwnIdea = (cell: GirdleCell): boolean =>
  cell.source === "observed" ||
  cell.source === "constrained" ||
  cell.source === "anchored" ||
  cell.source === "reconstructed";

const medianVec = (values: readonly Vec3[]): Vec3 => [
  medianOf(values.map((value) => value[0])),
  medianOf(values.map((value) => value[1])),
  medianOf(values.map((value) => value[2])),
];

const percentileOf = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

/**
 * A shoulder put back on its strut.
 *
 * Two things at once, and they are different in kind. The LENGTH is not
 * negotiable: the strut from the sternum to the shoulder is bone, so
 * whatever the evidence said, the shoulder sits exactly that far out. The
 * DIRECTION is, up to the swing this clip measured -- inside the cone the
 * evidence stands untouched, and outside it the direction is turned back to
 * the cone's edge along the shortest arc, which keeps whichever way the
 * shoulder was heading.
 *
 * This is the whole difference between a strut and a bubble. A bubble lets a
 * shoulder drift in and out as well as forward and back, so a reading that
 * had the shoulder too close to the midline stayed too close. A strut cannot
 * do that, and it means the pair's width follows from the swing rather than
 * being free alongside it.
 */
const ontoStrut = (
  point: Vec3,
  sternum: Vec3,
  restingDirection: Vec3,
  strutM: number,
  slackM: number,
  maxSwingRad: number
): Vec3 => {
  const offset = sub(point, sternum);
  if (dot(offset, offset) < 1e-12) return add(sternum, scale(restingDirection, strutM));
  const direction = normalise(offset);

  // The length, to within what the detector's own scatter on this marker was
  // measured to be. Correcting inside that would be chasing noise.
  const reachM = Math.hypot(offset[0], offset[1], offset[2]);
  const heldM = Math.min(strutM + slackM, Math.max(strutM - slackM, reachM));

  const swing = Math.acos(Math.max(-1, Math.min(1, dot(direction, restingDirection))));
  if (swing <= maxSwingRad) return add(sternum, scale(direction, heldM));

  // Turn the resting direction toward the evidence, but only as far as the
  // cone goes. An exactly opposite reading has no shortest arc; the resting
  // direction is then the only answer available.
  const axis = cross(restingDirection, direction);
  if (dot(axis, axis) < 1e-12) return add(sternum, scale(restingDirection, heldM));
  const turned = qRotate(qFromAxisAngle(axis, maxSwingRad), restingDirection);
  return add(sternum, scale(turned, heldM));
};

type CornerSet = Partial<Record<GirdleCorner, Vec3>>;

/**
 * What one frame saw of the girdle, from the raw observations.
 *
 * Only frames that saw both shoulders count: they are the girdle, and a
 * frame without them has nothing to teach about its shape. The pelvis is
 * required too, because the seed frame below needs a vertical and the hips
 * are the one that does not move with the thing being measured.
 */
const observedCorners = (
  tracks: Tracks,
  index: number,
  visibilityFloor: number
): CornerSet | null => {
  const seen = (joint: ClarityJoint): Vec3 | null => {
    const sample = tracks[joint].samples[index];
    return sample && sample.visibility >= visibilityFloor ? sample.position : null;
  };

  const leftShoulder = seen("leftShoulder");
  const rightShoulder = seen("rightShoulder");
  const leftHip = seen("leftHip");
  const rightHip = seen("rightHip");
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return null;

  const corners: CornerSet = {
    leftShoulder,
    rightShoulder,
    pelvis: lerpVec(leftHip, rightHip, 0.5),
  };
  const head = seen("head");
  if (head) corners.head = head;
  return corners;
};

const pairsFor = (
  template: Readonly<Record<GirdleCorner, Vec3>>,
  corners: CornerSet
): Correspondence[] =>
  GIRDLE_CORNERS.flatMap((corner) => {
    const to = corners[corner];
    return to ? [{ from: template[corner], to, weight: 1 }] : [];
  });

/**
 * The girdle's shape, measured over the clip.
 *
 * Seeded from a frame-by-frame basis and then refined by fitting: the seed
 * only has to be close enough for the first fit to converge, because each
 * round places the current shape on every frame, carries the observations
 * back into the body's own frame, and takes the median. After a few rounds
 * the shape no longer depends on the basis it started from -- which matters,
 * because that basis is built partly from the pelvis, and a shape measured
 * in a frame defined by the pelvis would report the pelvis as perfectly
 * rigid by construction rather than by evidence.
 */
const measureTemplate = (
  tracks: Tracks,
  options: Required<Pick<
    ShoulderGirdleOptions,
        | "measureVisibility"
    | "minSamples"
    | "allowancePercentile"
    | "maxAllowanceFraction"
    | "floppyFraction"
    | "maxSwingRad"
    | "maxStrutSlackFraction"
  >>
): { template: GirdleTemplate | null; skipped: string | null } => {
  const frameCount = tracks.leftShoulder.samples.length;
  const frames: CornerSet[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const corners = observedCorners(tracks, index, options.measureVisibility);
    if (corners) frames.push(corners);
  }
  if (frames.length < options.minSamples) {
    return {
      template: null,
      skipped: `only ${frames.length} frames saw both shoulders and both hips, so there is no girdle to measure`,
    };
  }

  // Seed: each frame's own basis -- across the shoulders, up toward them
  // from the hips -- and the median offset in it.
  const seedLocal: Record<GirdleCorner, Vec3[]> = {
    leftShoulder: [],
    rightShoulder: [],
    head: [],
    pelvis: [],
  };
  for (const corners of frames) {
    const origin = lerpVec(corners.leftShoulder!, corners.rightShoulder!, 0.5);
    const x = normalise(sub(corners.rightShoulder!, corners.leftShoulder!));
    const up = sub(origin, corners.pelvis!);
    const z = cross(x, up);
    if (dot(z, z) < 1e-9) continue;
    const zHat = normalise(z);
    const yHat = cross(zHat, x);
    for (const corner of GIRDLE_CORNERS) {
      const point = corners[corner];
      if (!point) continue;
      const offset = sub(point, origin);
      seedLocal[corner].push([dot(offset, x), dot(offset, yHat), dot(offset, zHat)]);
    }
  }
  if (seedLocal.leftShoulder.length < options.minSamples) {
    return { template: null, skipped: "the girdle's own basis could not be built on enough frames" };
  }

  let local = {
    leftShoulder: medianVec(seedLocal.leftShoulder),
    rightShoulder: medianVec(seedLocal.rightShoulder),
    head: seedLocal.head.length > 0 ? medianVec(seedLocal.head) : ([0, 0, 0] as Vec3),
    pelvis: medianVec(seedLocal.pelvis),
  } as Record<GirdleCorner, Vec3>;

  // Refine. Three rounds is well past where the shape stops moving on real
  // clips, and the cost is a handful of four-by-four iterations per frame.
  const fitOver = (shape: Record<GirdleCorner, Vec3>): (RigidFit | null)[] => {
    let seed: Quat = qIdentity();
    return frames.map((corners) => {
      const fit = fitRigidTransform(pairsFor(shape, corners), seed);
      if (fit) seed = fit.rotation;
      return fit;
    });
  };

  for (let round = 0; round < 3; round += 1) {
    const fits = fitOver(local);
    const gathered: Record<GirdleCorner, Vec3[]> = {
      leftShoulder: [],
      rightShoulder: [],
      head: [],
      pelvis: [],
    };
    for (let index = 0; index < frames.length; index += 1) {
      const fit = fits[index];
      if (!fit) continue;
      for (const corner of GIRDLE_CORNERS) {
        const point = frames[index][corner];
        if (!point) continue;
        gathered[corner].push(unapplyRigidFit(fit, point));
      }
    }
    if (gathered.leftShoulder.length === 0) break;

    const refined = { ...local };
    for (const corner of GIRDLE_CORNERS) {
      if (gathered[corner].length > 0) refined[corner] = medianVec(gathered[corner]);
    }
    // Keep the convention: the origin is the shoulder midpoint.
    const centre = lerpVec(refined.leftShoulder, refined.rightShoulder, 0.5);
    for (const corner of GIRDLE_CORNERS) refined[corner] = sub(refined[corner], centre);
    local = refined;
  }

  const widthM = distance(local.leftShoulder, local.rightShoulder);
  if (!(widthM > 1e-3)) {
    return { template: null, skipped: "the measured shoulders came out on top of each other" };
  }

  /*
   * The sternum, and the struts out to the shoulders.
   *
   * Placed rather than measured -- nothing in the clip saw it -- but what it
   * defines IS measured. Each strut's length is fixed by where the shoulders
   * actually sit, and then the clip is asked two separate questions about
   * every frame that saw the girdle: how far that strut swung off the
   * resting shape, and how much its length appeared to change.
   *
   * Keeping them apart is the point. The swing is movement: a scapula
   * riding forward and back is a real thing a body does, and it can be
   * degrees. The length change is not -- a strut is bone -- so whatever
   * appears there is the detector missing the acromion by a few millimetres,
   * and it comes out noise-sized. Measuring both means the stage can leave
   * the first alone and refuse the second without anyone deciding in advance
   * which is which.
   */
  const sternumLocal = sternumOffset(widthM);
  const strutM = {} as Record<Shoulder, number>;
  for (const shoulder of SHOULDERS) {
    strutM[shoulder] = distance(local[shoulder], sternumLocal);
  }

  // What each corner actually did against the finished shape.
  const residuals: Record<GirdleCorner, number[]> = {
    leftShoulder: [],
    rightShoulder: [],
    head: [],
    pelvis: [],
  };
  const swings: Record<Shoulder, number[]> = { leftShoulder: [], rightShoulder: [] };
  const strutErrors: Record<Shoulder, number[]> = { leftShoulder: [], rightShoulder: [] };

  const fits = fitOver(local);
  for (let index = 0; index < frames.length; index += 1) {
    const fit = fits[index];
    if (!fit) continue;
    for (const corner of GIRDLE_CORNERS) {
      const point = frames[index][corner];
      if (!point) continue;
      residuals[corner].push(distance(applyRigidFit(fit, local[corner]), point));
    }

    const sternum = applyRigidFit(fit, sternumLocal);
    for (const shoulder of SHOULDERS) {
      const seen = frames[index][shoulder];
      if (!seen) continue;
      const armM = distance(seen, sternum);
      strutErrors[shoulder].push(Math.abs(armM - strutM[shoulder]));
      const resting = sub(applyRigidFit(fit, local[shoulder]), sternum);
      const actual = sub(seen, sternum);
      if (dot(resting, resting) < 1e-12 || dot(actual, actual) < 1e-12) continue;
      swings[shoulder].push(
        Math.acos(
          Math.max(-1, Math.min(1, dot(normalise(resting), normalise(actual))))
        )
      );
    }
  }

  const allowanceM = {} as Record<GirdleCorner, number>;
  const rigidity = {} as Record<GirdleCorner, Unit>;
  const samples = {} as Record<GirdleCorner, number>;
  for (const corner of GIRDLE_CORNERS) {
    samples[corner] = residuals[corner].length;
    const wander = percentileOf(residuals[corner], options.allowancePercentile);
    allowanceM[corner] = Math.min(wander, widthM * options.maxAllowanceFraction);
    /*
     * Rigidity is taken from the RAW wander, not the capped allowance: a
     * corner that flew ten centimetres off the shape should reach zero say
     * in the fit, and capping first would leave it with a vote it has not
     * earned.
     *
     * And a corner nobody saw often enough has not shown that it is rigid,
     * so it gets no say at all rather than the benefit of the doubt.
     */
    rigidity[corner] =
      samples[corner] >= options.minSamples
        ? clampUnit(1 - wander / (widthM * options.floppyFraction))
        : 0;
  }

  const swingRad = {} as Record<Shoulder, number>;
  const strutSlackM = {} as Record<Shoulder, number>;
  for (const shoulder of SHOULDERS) {
    swingRad[shoulder] = Math.min(
      percentileOf(swings[shoulder], options.allowancePercentile),
      options.maxSwingRad
    );
    strutSlackM[shoulder] = Math.min(
      percentileOf(strutErrors[shoulder], options.allowancePercentile),
      widthM * options.maxStrutSlackFraction
    );
  }

  return {
    template: {
      local,
      rigidity,
      allowanceM,
      samples,
      widthM,
      sternumLocal,
      strutM,
      swingRad,
      strutSlackM,
      sampleCount: frames.length,
    },
    skipped: null,
  };
};

export const fitShoulderGirdle = (
  input: ShoulderGirdleInput,
  options: ShoulderGirdleOptions = {}
): ShoulderGirdleReport => {
  const settings = { ...DEFAULTS, ...options };
  const { cells, tracks, model } = input;
  const frameCount = tracks.leftShoulder.samples.length;

  const measured = input.template
    ? { template: input.template, skipped: null }
    : measureTemplate(tracks, settings);

  const carried: Record<Shoulder, number> = { leftShoulder: 0, rightShoulder: 0 };
  const reined: Record<Shoulder, number> = { leftShoulder: 0, rightShoulder: 0 };

  const template = measured.template;
  if (!template) {
    return { template: null, carried, reined, unfitted: 0, skipped: measured.skipped };
  }

  const noticeableM = model.estimatedHeightM * 0.01;
  const upperArmM: Record<Shoulder, number | null> = {
    leftShoulder: null,
    rightShoulder: null,
  };
  for (const shoulder of SHOULDERS) {
    const bone = model.bones[
      boneKey({ from: shoulder, to: ELBOW_OF[shoulder], structure: ARM_OF[shoulder], rigid: true })
    ];
    upperArmM[shoulder] =
      bone && bone.lengthM > 1e-4 && bone.confidence >= settings.minBoneConfidence
        ? bone.lengthM
        : null;
  }

  let seed: Quat = qIdentity();
  let unfitted = 0;

  for (let index = 0; index < frameCount; index += 1) {
    /*
     * What this frame offers each corner, weighted by how much that corner
     * is worth listening to at all. A floppy corner with a perfect sighting
     * still counts for little, and a rigid one that nobody saw counts for
     * nothing -- both are the same product.
     */
    const evidence = {} as Record<GirdleCorner, Unit>;
    const seen = {} as Record<GirdleCorner, Vec3>;
    for (const shoulder of SHOULDERS) {
      const cell = cells[shoulder][index];
      // A shoulder this stage placed itself is not evidence about where to
      // place it. The second pass would otherwise just confirm the first.
      evidence[shoulder] = hasOwnIdea(cell) ? evidenceOf(cell) : 0;
      seen[shoulder] = cell.position;
    }
    const headCell = cells.head[index];
    evidence.head = evidenceOf(headCell);
    seen.head = headCell.position;

    const leftHip = cells.leftHip[index];
    const rightHip = cells.rightHip[index];
    evidence.pelvis = Math.min(evidenceOf(leftHip), evidenceOf(rightHip));
    seen.pelvis = lerpVec(leftHip.position, rightHip.position, 0.5);

    const corners = GIRDLE_CORNERS.map((corner) => ({
      corner,
      pair: {
        from: template.local[corner],
        to: seen[corner],
        weight: evidence[corner] * template.rigidity[corner],
      } as Correspondence,
    }));

    const first = fitRigidTransform(
      corners.map((entry) => entry.pair),
      seed
    );
    if (!first) {
      unfitted += 1;
      continue;
    }
    let fit: RigidFit = first;

    /*
     * Refine, on two counts.
     *
     * THE ARMS. A shoulder nobody saw is still not free: its elbow was
     * somewhere, and the upper arm between them has a length this clip
     * measured. That pins the shoulder to a sphere about the elbow, which is
     * real evidence about the girdle's TURN -- the one thing the head and
     * the pelvis cannot supply. A sphere is not a correspondence, so it is
     * made into one the way the solver makes everything into one: project
     * the current estimate onto it and fit again.
     *
     * AND WHAT THE CORNERS ARE WORTH. A corner sitting further from the
     * shape than this golfer's girdle was ever seen to sit is, on this
     * frame, more likely a bad reading than a new fact about the anatomy --
     * so it loses say in proportion. The allowance decides that, which is
     * why it is measured rather than picked: a corner that habitually moves
     * has the room to move and keeps its vote, and one that does not,
     * does not.
     */
    for (let round = 0; round < 3; round += 1) {
      const weighted: Correspondence[] = corners.map(({ corner, pair }) => {
        if (!(pair.weight > 0)) return pair;
        const allowed = Math.max(template.allowanceM[corner], 1e-3);
        const strayM = distance(applyRigidFit(fit, pair.from), pair.to);
        return { ...pair, weight: pair.weight * (allowed / Math.max(allowed, strayM)) };
      });

      for (const shoulder of SHOULDERS) {
        if (evidence[shoulder] >= settings.carryBelow) continue;
        const armM = upperArmM[shoulder];
        if (!armM) continue;
        const elbow = cells[ELBOW_OF[shoulder]][index];
        const elbowEvidence = evidenceOf(elbow);
        if (elbowEvidence <= 0) continue;

        const away = sub(applyRigidFit(fit, template.local[shoulder]), elbow.position);
        if (dot(away, away) < 1e-9) continue;
        weighted.push({
          from: template.local[shoulder],
          to: add(elbow.position, scale(normalise(away), armM)),
          weight: elbowEvidence * template.rigidity[shoulder],
        });
      }

      const refit = fitRigidTransform(weighted, fit.rotation);
      if (!refit) break;
      fit = refit;
    }

    seed = fit.rotation;
    // How much the girdle was really placed by, rather than assumed into
    // position. A carried shoulder is only as good as the fit that carried it.
    const fitStrength = clampUnit(fit.weight);

    /*
     * The sternum, placed before the shoulders because they hang off it.
     * Never seen, always built, and never in a gap -- so it says so, rather
     * than inheriting the clip-length hole its own track looks like.
     */
    const sternumCell = cells.sternum[index];
    const sternum = applyRigidFit(fit, template.sternumLocal);
    sternumCell.correctionM += 0;
    sternumCell.position = sternum;
    sternumCell.source = "derived";
    sternumCell.trust = clampUnit(settings.carriedTrust * fitStrength);
    sternumCell.framesSinceObserved = 0;
    sternumCell.gapLength = 0;

    for (const shoulder of SHOULDERS) {
      const cell = cells[shoulder][index];
      const placed = applyRigidFit(fit, template.local[shoulder]);

      if (!hasOwnIdea(cell) || evidence[shoulder] <= 0) {
        // Nothing of its own worth keeping. The girdle says where it is.
        cell.correctionM += distance(cell.position, placed);
        cell.position = placed;
        cell.source = "derived";
        cell.trust = clampUnit(settings.carriedTrust * fitStrength);
        carried[shoulder] += 1;
        continue;
      }

      /*
       * It has an idea of its own, so the idea stands -- as far as the strut
       * allows it to swing, and no further. A weak sighting or a bridge
       * still knows which way the shoulder went; overruling it with the fit
       * would throw away the only evidence specific to this frame.
       */
      const resting = normalise(sub(placed, sternum));
      const held = ontoStrut(
        cell.position,
        sternum,
        resting,
        template.strutM[shoulder],
        template.strutSlackM[shoulder],
        template.swingRad[shoulder]
      );
      const movedM = distance(cell.position, held);
      if (movedM <= 1e-9) continue;
      cell.correctionM += movedM;
      cell.position = held;
      if (movedM > noticeableM && cell.source === "observed") cell.source = "constrained";
      reined[shoulder] += 1;
    }

    /*
     * The neck, last and by definition: `observe/` derives it as the
     * shoulder midpoint, so that is what it is, on every frame, whatever
     * the detector reported for it.
     */
    const neck = cells.neck[index];
    const midpoint = lerpVec(cells.leftShoulder[index].position, cells.rightShoulder[index].position, 0.5);
    const neckMovedM = distance(neck.position, midpoint);
    neck.correctionM += neckMovedM;
    neck.position = midpoint;
    if (neck.source === "missing" || neck.source === "extrapolated") {
      neck.source = "derived";
      neck.trust = clampUnit(settings.carriedTrust * fitStrength);
    } else if (neckMovedM > noticeableM && neck.source === "observed") {
      neck.source = "constrained";
    }
  }

  return { template, carried, reined, unfitted, skipped: null };
};
