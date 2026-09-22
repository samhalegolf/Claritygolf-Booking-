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
 * THE CAVEAT: A GIRDLE IS RIGID, NOT WELDED
 *
 * Scapulae retract and protract. A shoulder rides forward at the top and
 * back through impact, and the two do not do it together. Treating the
 * girdle as perfectly rigid would be a cleaner assumption and a wrong one:
 * it would iron out a real movement, and worse, it would iron it out
 * silently.
 *
 * So every corner gets an ALLOWANCE, and the allowance is measured, not
 * chosen. On the frames that saw the girdle properly, the template is fitted
 * and the residual recorded; the ninetieth percentile of those residuals is
 * how far that corner was actually seen to wander on this clip. Inside its
 * allowance a corner's own evidence stands untouched. Outside it, the
 * evidence is pulled back to the edge -- the same bubble the grip uses, for
 * the same reason.
 *
 * That measurement does double duty. A corner that held its place is
 * trusted to place the others; one that wandered is not. A clip where the
 * head swivels independently of the shoulders -- which is every golf swing
 * -- measures a floppy head and gives it almost no say, without anybody
 * having to write down that a golfer keeps their head still.
 *
 * WHAT THE ALLOWANCE CANNOT SEE, AND WHY IT DOES NOT PRETEND TO
 *
 * One shoulder sliding forward while the other holds is, to these
 * landmarks, the same thing as the whole girdle turning a degree or two
 * further. The fit absorbs it as turn and reports no deviation at all --
 * not because the deviation was ironed out, but because nothing in shoulder,
 * head and hip positions distinguishes the two. Separating them needs a
 * landmark on the sternum, and there is not one.
 *
 * So what gets measured is the part that IS visible: the pair narrowing and
 * widening, and the pair sliding relative to the head and the hips. That is
 * the symmetric half of scapular travel, and it is real. The asymmetric half
 * is quietly counted as turn, which is the honest place to put evidence that
 * cannot tell the difference -- and one more reason the shoulder turn this
 * layer reports is a measurement of landmarks rather than of bone.
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
  qIdentity,
  scale,
  sub,
  unapplyRigidFit,
  type Correspondence,
  type RigidFit,
} from "../../contracts";
import type { MeasuredBodyModel } from "./bodyModel";
import { medianOf, type Tracks } from "./tracks";

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

/** The point, pulled to within `radiusM` of `centre` on its own bearing. */
const intoBubble = (point: Vec3, centre: Vec3, radiusM: number): Vec3 => {
  const d = distance(point, centre);
  if (d <= radiusM) return point;
  return add(centre, scale(sub(point, centre), radiusM / d));
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
    "measureVisibility" | "minSamples" | "allowancePercentile" | "maxAllowanceFraction" | "floppyFraction"
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

  // What each corner actually did against the finished shape.
  const residuals: Record<GirdleCorner, number[]> = {
    leftShoulder: [],
    rightShoulder: [],
    head: [],
    pelvis: [],
  };
  const fits = fitOver(local);
  for (let index = 0; index < frames.length; index += 1) {
    const fit = fits[index];
    if (!fit) continue;
    for (const corner of GIRDLE_CORNERS) {
      const point = frames[index][corner];
      if (!point) continue;
      residuals[corner].push(distance(applyRigidFit(fit, local[corner]), point));
    }
  }

  const widthM = distance(local.leftShoulder, local.rightShoulder);
  if (!(widthM > 1e-3)) {
    return { template: null, skipped: "the measured shoulders came out on top of each other" };
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
     */
    // A corner nobody saw often enough has not shown that it is rigid, so it
    // gets no say at all rather than the benefit of the doubt.
    rigidity[corner] =
      samples[corner] >= options.minSamples
        ? clampUnit(1 - wander / (widthM * options.floppyFraction))
        : 0;
  }

  return {
    template: { local, rigidity, allowanceM, samples, widthM, sampleCount: frames.length },
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
       * It has an idea of its own, so the idea stands -- as far as the
       * girdle allows that corner to wander, and no further. A weak sighting
       * or a bridge still knows which way the shoulder went; overruling it
       * with the fit would throw away the only evidence specific to this
       * frame.
       */
      const held = intoBubble(cell.position, placed, template.allowanceM[shoulder]);
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
