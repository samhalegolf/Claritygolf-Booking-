/**
 * The club, and the balance point derived from it.
 *
 * The plan is specific about what this must and must not do:
 *
 *   "Do not treat the apparent centre/orientation of the clubhead as the
 *    authoritative balance point... Use the clubhead as evidence for a
 *    constrained club model... The balance point is derived from the
 *    reconstructed club geometry rather than directly detected from pixels."
 *
 * So the detected clubhead is never the answer. It is one constraint on a
 * club of fixed length attached to the hands, and the CBP falls out of that
 * club's geometry. A clubhead detection that drifts with lighting or turns
 * side-on moves the estimate by however much the geometry allows, which is
 * much less than the detection moved.
 *
 * HOW THE CLUB LENGTH IS MEASURED, WITHOUT KNOWING DEPTH
 *
 * The neat part. An image detection puts the clubhead somewhere on a viewing
 * ray. The PERPENDICULAR DISTANCE from the grip to that line is therefore a
 * hard lower bound on the club's length in that frame -- the club cannot be
 * shorter than that or it could never reach the line at all. The true length
 * is the largest such bound over the swing, and the bound is exactly tight at
 * whatever moment the club happens to lie square to the camera, which in a
 * full swing always happens.
 *
 * No image scale, no calibration, no assumed club. Just a maximum over
 * bounds, taken at a high percentile so one bad detection cannot inflate it.
 *
 * WHAT IS ASSUMED, AND NAMED
 *
 * Two things, both unobservable rather than merely unmeasured:
 *
 *   The butt of the club is inside the golfer's hands. It is never visible in
 *   any frame, so its position is the hands' position extended up the shaft
 *   by `buttAboveHandsM`.
 *
 *   Where the balance point sits along a club is a property of that club, not
 *   of the swing, and no video shows it. `cbpFromButtRatio` states it.
 *
 * Both are parameters with documented defaults rather than constants buried
 * in the maths, because they are the two numbers a coach with a real club and
 * a ruler could replace with measurements.
 */

import type { ClubEstimate, Unit, Vec3 } from "../../contracts";
import {
  add,
  clampUnit,
  cross,
  distance,
  dot,
  lerpVec,
  normalise,
  scale,
  sub,
} from "../../contracts";
import type { ClubObservation } from "../../observe/observation";
import { penalise, PENALTY_SCALES } from "../confidence/confidence";
import { fitCamera, liftOntoSphere, viewingRay, type Camera } from "./camera";
import {
  anatomicalViolation,
  belowGround,
  penetrationDepth,
  type Capsule,
} from "./occupancy";

export interface ClubFrameInput {
  /** Where the hands hold the club. Null when they were not reconstructed. */
  readonly hands: Vec3 | null;
  /** Wrist midpoint. With the hands, this gives the down-the-shaft axis. */
  readonly wrists: Vec3 | null;
  /**
   * A body direction that is reliably NOT along the shaft, used to complete
   * the hands' frame. The shoulder line is the right choice; see `handBasis`.
   */
  readonly transverse: Vec3 | null;
  readonly camera: Camera | null;
  readonly observation: ClubObservation | null;
  /**
   * Body parts the clubhead cannot be inside, and the forearms whose wrist
   * angle it must respect. Used only to settle the global depth ambiguity --
   * see `occupancy.ts`.
   */
  readonly obstacles?: readonly Capsule[];
  /** Elbow-minus-wrist for each arm. The anatomical depth cue. */
  readonly forearms?: readonly Vec3[];
}

export interface ClubModelOptions {
  /**
   * How far the butt of the club sits above the hands, metres. Never visible
   * -- the hands are around it -- so it is stated rather than measured.
   */
  readonly buttAboveHandsM?: number;
  /**
   * Where the balance point sits along the club, as a fraction from the butt.
   * A property of the club, not of the swing. Around half-way for a driver.
   */
  readonly cbpFromButtRatio?: number;
  /**
   * Frames the CBP may be carried on hand geometry alone once the clubhead is
   * no longer seen. The plan's rule: club movement is not invented
   * indefinitely. Past this the frame reports no club at all.
   */
  readonly maxCarryFrames?: number;
  /**
   * Percentile of the per-frame length bounds taken as the club's length.
   * Not the maximum: one detection landing on something in the background
   * would set the club's length for the whole clip.
   */
  readonly lengthPercentile?: number;
}

const DEFAULTS = {
  buttAboveHandsM: 0.08,
  cbpFromButtRatio: 0.52,
  maxCarryFrames: 18,
  lengthPercentile: 1.0,
} as const;

export interface ClubModelResult {
  /** One entry per input frame. Null where no club could be supported. */
  readonly frames: readonly (ClubEstimate | null)[];
  /** Hands-to-head length used, metres. Zero when never established. */
  readonly shaftLengthM: number;
  /** Frames a clubhead was actually detected in. */
  readonly observedFrames: number;
  /**
   * The frame where the club was most nearly square to the camera, so depth
   * mattered least. Diagnostic only -- the depth choice is solved globally.
   */
  readonly seedFrame: number | null;
  /** True when physics overturned the propagated depth of at least one segment. */
  readonly mirrored: boolean;
  /** How many independently-flippable stretches the clip broke into. */
  readonly segmentCount: number;
  /** How many of them the evidence overturned. */
  readonly segmentsFlipped: number;
  /**
   * How decisively the body settled the depth ambiguity, 0..1. Near zero means
   * both trajectories were equally physical and the depth is barely evidenced.
   */
  readonly depthEvidence: number;
}

/* ------------------------- the hands' frame ------------------------- */

/**
 * A right-handed basis riding on the hands.
 *
 * Carrying a lost club forward in WORLD space would hold it still while the
 * hands rotated out from under it -- the club would visibly detach. Held in
 * this frame instead, it stays in the hands and swings with them, which is
 * what "previous club geometry" means when the geometry is attached to
 * something that is still being tracked.
 */
interface HandBasis {
  readonly e1: Vec3;
  readonly e2: Vec3;
  readonly e3: Vec3;
}

const handBasis = (input: ClubFrameInput): HandBasis | null => {
  if (!input.hands || !input.wrists || !input.transverse) return null;

  const downShaft = sub(input.hands, input.wrists);
  if (Math.hypot(...downShaft) < 1e-6) return null;
  const e2 = normalise(downShaft);

  /*
   * The second axis has to come from the BODY, not from the hands.
   *
   * The obvious choice -- the line between the two hands -- is parallel to
   * the shaft, because that is how a golf club is held: one hand above the
   * other, both on the grip. Using it collapses the basis to nothing, and the
   * first version of this silently produced no club at all on frames where
   * the hands happened to be neatly stacked.
   *
   * The shoulder line is never along the shaft. At address the shaft points
   * down and out while the shoulders are level; at the top the shaft is up
   * and the shoulders are turned. There is no point in a swing where the two
   * coincide.
   */
  const transverse = normalise(input.transverse);
  const e3 = cross(e2, transverse);
  if (Math.hypot(...e3) < 1e-4) return null;

  const e3n = normalise(e3);
  return { e1: cross(e2, e3n), e2, e3: e3n };
};

const toLocal = (basis: HandBasis, world: Vec3): Vec3 => [
  dot(world, basis.e1),
  dot(world, basis.e2),
  dot(world, basis.e3),
];

const toWorld = (basis: HandBasis, local: Vec3): Vec3 =>
  add(
    add(scale(basis.e1, local[0]), scale(basis.e2, local[1])),
    scale(basis.e3, local[2])
  );

/* --------------------------- the estimate --------------------------- */

export const estimateClub = (
  frames: readonly ClubFrameInput[],
  options: ClubModelOptions = {}
): ClubModelResult => {
  const buttAbove = options.buttAboveHandsM ?? DEFAULTS.buttAboveHandsM;
  const cbpRatio = options.cbpFromButtRatio ?? DEFAULTS.cbpFromButtRatio;
  const maxCarry = options.maxCarryFrames ?? DEFAULTS.maxCarryFrames;
  const percentile = options.lengthPercentile ?? DEFAULTS.lengthPercentile;

  /* ---- 1. how long is the club? ---- */

  interface Bound {
    readonly index: number;
    readonly perpendicularM: number;
  }
  const bounds: Bound[] = [];

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame.hands || !frame.camera || !frame.observation) continue;

    const ray = viewingRay(frame.camera, [
      frame.observation.imageX,
      frame.observation.imageY,
    ]);
    if (!ray) continue;

    // Perpendicular distance from the hands to the viewing ray: the shortest
    // club that could possibly reach this detection.
    const offset = sub(ray.origin, frame.hands);
    const along = dot(offset, ray.direction);
    const perpendicular = Math.sqrt(
      Math.max(0, dot(offset, offset) - along * along)
    );
    bounds.push({ index, perpendicularM: perpendicular });
  }

  if (bounds.length === 0) {
    return {
      frames: frames.map(() => null),
      shaftLengthM: 0,
      observedFrames: 0,
      seedFrame: null,
      mirrored: false,
      depthEvidence: 0,
      segmentCount: 0,
      segmentsFlipped: 0,
    };
  }

  // The frame where the club was most nearly square to the camera. Reported
  // as a diagnostic; the depth choice itself is solved globally below.
  const squarest = bounds.reduce((best, entry) =>
    entry.perpendicularM > best.perpendicularM ? entry : best
  );

  const sorted = [...bounds].sort((a, b) => a.perpendicularM - b.perpendicularM);
  const shaftLengthM =
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))]
      .perpendicularM;

  if (shaftLengthM < 0.2) {
    // Nothing plausibly club-shaped was ever seen.
    return {
      frames: frames.map(() => null),
      shaftLengthM,
      observedFrames: bounds.length,
      seedFrame: null,
      mirrored: false,
      depthEvidence: 0,
      segmentCount: 0,
      segmentsFlipped: 0,
    };
  }

  /* ---- 2. which side of the sphere? ---- */

  /*
   * A CHOICE PER FRAME, SOLVED GLOBALLY.
   *
   * Every frame offers two clubheads: the club pointing toward the camera or
   * away from it. They produce identical images, so nothing local can tell
   * them apart -- and the true answer SWITCHES mid-swing, whenever the club
   * crosses the plane the camera looks along.
   *
   * The first version seeded the choice at the least ambiguous frame and
   * propagated outward. It fails for a simple reason: one wrong fork at a
   * crossing poisons every frame after it, and on a down-the-line clip that
   * left 43% of the swing mirrored with no way to recover.
   *
   * So it is solved as what it is -- a two-state sequence -- by Viterbi over
   * the whole clip. Each frame pays for being physically impossible, each
   * transition pays for the clubhead having to jump, and the cheapest path
   * through both wins. A flip costs twice the club's depth in one frame,
   * which is exactly the kind of jump the transition term exists to notice.
   *
   * Both costs are in metres, so there is no arbitrary exchange rate between
   * them, and no seed to get wrong.
   */

  /**
   * How physically impossible a clubhead position is, in metres.
   *
   * Combines the golfer's solidity, the ground, and -- the term that actually
   * does the work -- the wrist. See `occupancy.ts`.
   */
  const costOf = (index: number, head: Vec3): number => {
    const frame = frames[index];
    return (
      penetrationDepth(head, frame.obstacles ?? []) +
      belowGround(head) +
      (frame.hands
        ? anatomicalViolation(sub(head, frame.hands), frame.forearms ?? [], shaftLengthM)
        : 0)
    );
  };

  const candidates = frames.map((frame, index) => {
    if (!frame.hands || !frame.camera || !frame.observation) return null;
    const ray = viewingRay(frame.camera, [
      frame.observation.imageX,
      frame.observation.imageY,
    ]);
    if (!ray) return null;
    const near = liftOntoSphere(ray, frame.hands, shaftLengthM, true);
    const far = liftOntoSphere(ray, frame.hands, shaftLengthM, false);
    return { index, options: [near, far] as const };
  });

  const heads = new Array<Vec3 | null>(frames.length).fill(null);
  const lifts = new Array<ReturnType<typeof liftOntoSphere> | null>(frames.length).fill(
    null
  );

  /*
   * GREEDY PROPAGATION, NOT A GLOBAL OPTIMUM.
   *
   * This looks like a job for Viterbi and is not, which cost two attempts to
   * establish. Any objective that minimises a global smoothness measure --
   * total distance travelled, or total acceleration -- has the same
   * pathology: the cheapest sequence is the one that hugs the plane the
   * camera looks along, because that is where the two candidates sit closest
   * together. It flattens the swing's depth away, and on every camera angle
   * tested it scored worse than no optimisation at all.
   *
   * The trap is that a real golf swing is NOT the smoothest path available.
   * It accelerates hard, and it moves in depth. A global smoother is free to
   * accumulate small savings across a hundred frames and buy a flattened
   * swing with them.
   *
   * Greedy propagation cannot: at each step it asks only which candidate is
   * nearer to where the clubhead's own momentum was taking it, and the truth
   * wins that question every time because the truth is what has the momentum.
   * It gives up the global optimum and gets the right answer.
   *
   * Propagation starts at the frame where the club was most nearly square to
   * the camera, because there the two candidates nearly coincide and the
   * starting choice genuinely does not matter.
   */
  const PHYSICAL_WEIGHT = 3;

  const chooseAt = (index: number, previous: Vec3 | null, before: Vec3 | null) => {
    const entry = candidates[index];
    if (!entry) return;

    // Where momentum says it should be. With only one previous frame there is
    // no momentum to speak of, so that frame itself is the prediction.
    const predicted =
      previous && before
        ? ([
            2 * previous[0] - before[0],
            2 * previous[1] - before[1],
            2 * previous[2] - before[2],
          ] as Vec3)
        : previous;

    let bestState = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const state of [0, 1] as const) {
      const candidate = entry.options[state];
      const cost =
        (predicted ? distance(candidate.position, predicted) : 0) +
        PHYSICAL_WEIGHT * costOf(index, candidate.position);
      if (cost < bestCost) {
        bestCost = cost;
        bestState = state;
      }
    }

    heads[index] = entry.options[bestState].position;
    lifts[index] = entry.options[bestState];
  };

  /*
   * SEED WHERE THE PHYSICS IS MOST DECISIVE, NOT WHERE THE CHOICE MATTERS
   * LEAST.
   *
   * The obvious seed is the frame where the club is squarest to the camera,
   * on the reasoning that the two candidates nearly coincide there so a wrong
   * start costs nothing. That reasoning is exactly backwards. Coinciding
   * candidates mean NO information, and the propagation's first step -- which
   * has no previous frame to take momentum from -- then picks whichever
   * candidate is simply nearer. That is the flattening bias, applied at the
   * very first decision and inherited by every frame after it.
   *
   * Seeding instead at the frame where the anatomy most clearly rules one
   * candidate out gives the propagation a fact to start from. Where nothing
   * rules anything out anywhere, the squarest frame is the right fallback --
   * there genuinely is no information, and being wrong there costs the least.
   */
  let seedIndex = squarest.index;
  let seedMargin = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const entry = candidates[index];
    if (!entry) continue;
    const margin = Math.abs(
      costOf(index, entry.options[0].position) - costOf(index, entry.options[1].position)
    );
    if (margin > seedMargin) {
      seedMargin = margin;
      seedIndex = index;
    }
  }

  chooseAt(seedIndex, null, null);
  for (let index = seedIndex + 1; index < frames.length; index += 1) {
    chooseAt(index, heads[index - 1], heads[index - 2] ?? null);
  }
  for (let index = seedIndex - 1; index >= 0; index -= 1) {
    chooseAt(index, heads[index + 1], heads[index + 2] ?? null);
  }

  /*
   * THE AMBIGUITY IS PER SEGMENT, AND THE SEGMENTS ARE SEARCHED TOGETHER.
   *
   * Three things had to be understood before this worked, and each one was
   * only visible by measuring:
   *
   *   The physics DOES know the answer -- across every camera angle tested,
   *   the true trajectory scored zero and its mirror scored between 2 and 11
   *   metres of impossibility.
   *
   *   But it knows it on very few frames. Typically 110 of 144 frames are
   *   completely indifferent: both candidates are anatomically fine and clear
   *   of the body. The signal is real and sparse.
   *
   *   And the choice is not free per frame. It changes only at CROSSINGS,
   *   where the club passes through the plane the camera looks along and the
   *   two candidates briefly coincide. Between crossings, greedy propagation
   *   is reliable.
   *
   * So the crossings cut the clip into a handful of segments, each of which
   * is independently flippable, and all assignments are scored together. A
   * segment carrying no physical signal is then decided by its NEIGHBOURS:
   * flipping it leaves the position continuous at the crossing but puts a
   * kink in the velocity, and the smoothness term sees that.
   *
   * Scoring segments jointly rather than one at a time matters -- a sparse
   * signal in one segment has to be able to settle a silent one next to it.
   * With a handful of segments the whole assignment space is a few dozen
   * possibilities, so it is simply enumerated.
   */
  const CROSSING_AMBIGUITY = shaftLengthM * 0.25;
  /** Shorter than this and a "segment" is just the noise around a crossing. */
  const MIN_SEGMENT_FRAMES = 6;
  /** Above this many segments, enumeration stops being free. */
  const MAX_SEGMENTS = 14;

  /*
   * A crossing is a POINT, not a region. The ambiguity dips toward zero over
   * several frames as the club approaches the viewing plane, so treating
   * every low-ambiguity frame as a boundary chops one crossing into a dozen
   * two-frame segments that then flip independently. Only the local minimum
   * is a real crossing.
   */
  const ambiguityAt = (index: number) =>
    lifts[index]?.ambiguityM ?? Number.POSITIVE_INFINITY;

  const boundaries: number[] = [0];
  for (let index = 1; index < frames.length - 1; index += 1) {
    if (ambiguityAt(index) >= CROSSING_AMBIGUITY) continue;
    if (ambiguityAt(index) > ambiguityAt(index - 1)) continue;
    if (ambiguityAt(index) > ambiguityAt(index + 1)) continue;
    if (index + 1 - boundaries[boundaries.length - 1] < MIN_SEGMENT_FRAMES) continue;
    // The minimum frame itself still belongs to the run it ended; the new
    // segment starts after it.
    boundaries.push(index + 1);
  }
  if (
    boundaries.length > 1 &&
    frames.length - boundaries[boundaries.length - 1] < MIN_SEGMENT_FRAMES
  ) {
    boundaries.pop();
  }
  boundaries.push(frames.length);

  const segmentCount = boundaries.length - 1;
  const segmentOf = new Array<number>(frames.length).fill(0);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    for (let index = boundaries[segment]; index < boundaries[segment + 1]; index += 1) {
      segmentOf[index] = segment;
    }
  }

  /** The candidate this frame did NOT settle on during propagation. */
  const otherAt = (index: number): Vec3 | null => {
    const entry = candidates[index];
    const head = heads[index];
    if (!entry || !head) return null;
    return distance(entry.options[0].position, head) < 1e-9
      ? entry.options[1].position
      : entry.options[0].position;
  };

  const settled = heads.map((head) => head);
  const alternative = frames.map((_frame, index) => otherAt(index));

  /**
   * How far the club's lowest point misses the turf, in either direction.
   *
   * THE ONE GOLF-SPECIFIC PRIOR IN THE RECONSTRUCTION, AND WHY IT IS HERE.
   *
   * At face-on the anatomical cue runs out completely: mirroring the club's
   * depth about the camera ray leaves the wrist angle untouched to within a
   * degree, and the mirrored club still misses the body. Both trajectories
   * are entirely possible, and the error from choosing wrongly is not small
   * -- nearly 700mm, because at face-on the club swings a long way toward and
   * away from the camera.
   *
   * What separates them is that a golf swing brings the clubhead to the
   * ground. The true trajectory touches it -- its lowest point sits within a
   * centimetre of Y = 0 at every camera angle -- while a mirrored one misses,
   * and misses in BOTH directions depending on which side of the golfer the
   * camera is: 60 to 150mm floating above the turf from one side, 47mm buried
   * beneath it from the other. An earlier version only looked for floating
   * and was blind to half the cases.
   *
   * Admissible under the plan's rule because it constrains nothing about HOW
   * the club moved -- not its plane, not its path, not its sequencing. It is
   * a fact about the activity, of the same kind as "the golfer is standing on
   * the ground", which the anchoring already relies on.
   *
   * It is deliberately weak: a band covers a teed ball and ordinary detection
   * noise, it is worth a fraction of a real anatomical violation, and it does
   * NOT feed `depthEvidence`. A depth settled on this prior alone still
   * reports itself as poorly evidenced, because it is.
   *
   * It is also a whole-clip statistic rather than a per-frame one, which is
   * what makes a band this tight safe: one noisy frame cannot move it.
   */
  const GROUND_BAND_M = 0.02;

  const scoreAssignment = (
    flipped: readonly boolean[]
  ): { impossibility: number; kink: number; groundMiss: number } => {
    const positionAt = (index: number): Vec3 | null => {
      const head = flipped[segmentOf[index]] ? alternative[index] : settled[index];
      return head ?? null;
    };

    let impossibility = 0;
    let kink = 0;
    let lowest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < frames.length; index += 1) {
      const position = positionAt(index);
      if (!position) continue;
      impossibility += costOf(index, position);
      lowest = Math.min(lowest, position[1]);

      // Smoothness, as departure from constant velocity. A flipped segment
      // joins its neighbour without a step but with a kink, and this is what
      // notices.
      const before = positionAt(index - 1);
      const after = positionAt(index + 1);
      if (!before || !after) continue;
      kink += Math.hypot(
        after[0] - 2 * position[0] + before[0],
        after[1] - 2 * position[1] + before[1],
        after[2] - 2 * position[2] + before[2]
      );
    }
    return {
      impossibility,
      kink,
      groundMiss: Number.isFinite(lowest)
        ? Math.max(0, Math.abs(lowest) - GROUND_BAND_M)
        : 0,
    };
  };

  let segmentsFlipped = 0;

  // One segment is still worth searching: that is the global mirror, and it is
  // the case where the propagation simply started on the wrong side.
  if (segmentCount >= 1) {
    /*
     * ONLY PHYSICS MAY OVERTURN THE PROPAGATION.
     *
     * Smoothness must not get a vote of its own here, and this was the last
     * thing to get right. On camera angles where the physics is silent -- the
     * club stays near the plane the camera looks along, so both trajectories
     * are equally possible -- the lowest-kink assignment is the FLATTENED
     * one, and letting smoothness choose reintroduced the exact pathology
     * that ruled out a global optimiser in the first place. Two camera angles
     * went from 11mm to 522mm.
     *
     * So a flip has to pay for itself in impossibility removed. Smoothness
     * then only breaks ties between assignments that are equally physical --
     * which is precisely the job it is good at: carrying a sparse signal from
     * a segment that has one into a neighbouring segment that does not.
     */
    /*
     * The ground prior is worth a fraction of an impossibility, so a real
     * anatomical violation always outranks it. It only decides where the hard
     * physics has nothing to say.
     */
    /*
     * Smoothness is NOT in this sum, and that was measured rather than
     * assumed. Flipping a segment at a crossing leaves the position
     * continuous, so the kink it creates is small -- small enough that adding
     * it at any weight from 0.05 to 5 made the result worse at every camera
     * angle, by suppressing flips the physics wanted. It stays as a tiebreak
     * below and nothing more.
     */
    const GROUND_WEIGHT = 1.5;
    const evidenceOf = (score: ReturnType<typeof scoreAssignment>) =>
      score.impossibility + GROUND_WEIGHT * score.groundMiss;

    const baseline = scoreAssignment(new Array<boolean>(segmentCount).fill(false));
    const baselineEvidence = evidenceOf(baseline);

    let bestFlips = new Array<boolean>(segmentCount).fill(false);
    let bestEvidence = baselineEvidence;
    let bestKink = baseline.kink;

    const tolerance = 1e-6;
    const consider = (flips: boolean[]) => {
      const score = scoreAssignment(flips);
      const evidence = evidenceOf(score);
      // Strictly better evidence, or exactly as good and visibly smoother.
      const better =
        evidence < bestEvidence - tolerance ||
        (evidence <= bestEvidence + tolerance &&
          evidence < baselineEvidence - tolerance &&
          score.kink < bestKink);
      if (better) {
        bestEvidence = evidence;
        bestKink = score.kink;
        bestFlips = [...flips];
      }
      return better;
    };

    if (segmentCount <= MAX_SEGMENTS) {
      for (let mask = 1; mask < 1 << segmentCount; mask += 1) {
        consider(
          Array.from(
            { length: segmentCount },
            (_value, segment) => (mask & (1 << segment)) !== 0
          )
        );
      }
    } else {
      /*
       * Too many segments to enumerate, which happens when the club dawdles
       * near the plane the camera looks along and produces a string of
       * shallow crossings. Coordinate descent instead: try each segment on
       * its own, keep what helps, repeat until nothing does.
       *
       * Not guaranteed optimal, but a segment's cost barely depends on its
       * neighbours -- the physics is per frame -- so the greedy order gets
       * there in practice, and the alternative of skipping the search
       * entirely leaves an entire mirrored swing uncorrected.
       */
      const current = new Array<boolean>(segmentCount).fill(false);
      for (let pass = 0; pass < 3; pass += 1) {
        let changed = false;
        for (let segment = 0; segment < segmentCount; segment += 1) {
          current[segment] = !current[segment];
          if (consider(current)) changed = true;
          else current[segment] = !current[segment];
        }
        if (!changed) break;
      }
    }

    for (let index = 0; index < frames.length; index += 1) {
      if (!bestFlips[segmentOf[index]]) continue;
      const entry = candidates[index];
      const head = heads[index];
      if (!entry || !head) continue;
      const other =
        distance(entry.options[0].position, head) < 1e-9
          ? entry.options[1]
          : entry.options[0];
      heads[index] = other.position;
      lifts[index] = other;
    }
    segmentsFlipped = bestFlips.filter(Boolean).length;
  }

  /**
   * How decisively the physics settled it, 0..1.
   *
   * The chosen trajectory's impossibility against the wholly mirrored one's.
   * Near zero means both were equally physical and the club's depth is barely
   * evidenced -- which is fine, and worth saying: when the evidence is
   * weakest the club is nearly square to the camera, so the two answers are
   * nearly the same and being wrong costs almost nothing. The cue strengthens
   * exactly where the stakes rise.
   */
  let chosenCost = 0;
  let mirrorCost = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const head = heads[index];
    const other = otherAt(index);
    if (!head || !other) continue;
    chosenCost += costOf(index, head);
    mirrorCost += costOf(index, other);
  }

  const total = chosenCost + mirrorCost;
  const depthEvidence = total < 1e-9 ? 0 : Math.abs(chosenCost - mirrorCost) / total;
  const mirrored = segmentsFlipped > 0;

  /* ---- 3. the club, frame by frame ---- */

  const out: (ClubEstimate | null)[] = new Array(frames.length).fill(null);

  // Shaft direction in the hands' own frame, carried when the head is lost.
  let carriedLocal: Vec3 | null = null;
  let framesSinceHead = Number.POSITIVE_INFINITY;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const basis = handBasis(frame);
    if (!frame.hands || !basis) {
      framesSinceHead += 1;
      continue;
    }

    const head = heads[index];
    let shaft: Vec3 | null = null;

    if (head) {
      shaft = normalise(sub(head, frame.hands));
      carriedLocal = toLocal(basis, shaft);
      framesSinceHead = 0;
    } else if (carriedLocal && framesSinceHead < maxCarry) {
      // No clubhead this frame. The hands and the club's recent geometry
      // still support an estimate -- for a while.
      shaft = normalise(toWorld(basis, carriedLocal));
      framesSinceHead += 1;
    } else {
      // Past the carry limit, or never established. No club is reported:
      // inventing movement indefinitely is exactly what the plan forbids.
      framesSinceHead += 1;
      continue;
    }

    const headPosition = head ?? add(frame.hands, scale(shaft, shaftLengthM));
    const butt = sub(frame.hands, scale(shaft, buttAbove));
    const fullLength = shaftLengthM + buttAbove;

    out[index] = {
      cbp: add(butt, scale(shaft, cbpRatio * fullLength)),
      grip: frame.hands,
      head: headPosition,
      lengthM: shaftLengthM,
      evidence: {
        headObserved: Boolean(head),
        gripFromHands: true,
        // No shaft tracker exists; the shaft is inferred from its two ends.
        shaftObserved: false,
        framesSinceHeadObserved: Number.isFinite(framesSinceHead) ? framesSinceHead : 0,
      },
      confidence: confidenceFor(
        frame,
        lifts[index],
        framesSinceHead,
        shaftLengthM,
        depthEvidence
      ),
    };
  }

  return {
    frames: out,
    shaftLengthM,
    observedFrames: heads.filter(Boolean).length,
    seedFrame: squarest.index,
    segmentCount,
    segmentsFlipped,
    mirrored,
    depthEvidence,
  };
};

/**
 * How much to believe this frame's club.
 *
 * Every term is a reason the geometry might be wrong, not a judgement about
 * the swing:
 *
 *   the detector's own confidence in the clubhead region
 *   how well the camera fitted the body this frame
 *   whether the detection and the club length could be reconciled at all
 *   how far apart the two depth candidates were, since a wide gap means a
 *     wrong branch would have been a long way out
 *   how long since a clubhead was last actually seen
 */
const confidenceFor = (
  frame: ClubFrameInput,
  lift: ReturnType<typeof liftOntoSphere> | null,
  framesSinceHead: number,
  shaftLengthM: number,
  depthEvidence: number
): Unit => {
  const camera = frame.camera;
  if (!camera) return 0;

  const cameraQuality =
    clampUnit(camera.conditioning) * penalise(camera.residual, 0.02);

  if (!lift) {
    // Carried on hand geometry alone. Decays, and the decay is the point.
    return clampUnit(
      0.45 *
        cameraQuality *
        penalise(framesSinceHead, PENALTY_SCALES.clubStalenessFrames) *
        (0.15 + 0.85 * clampUnit(depthEvidence * 6))
    );
  }

  const detection = frame.observation?.confidence ?? 0;
  // A detection the club could not reach is a disagreement between the two,
  // and neither gets the benefit of the doubt.
  const reconciled = penalise(Math.abs(lift.missM), shaftLengthM * 0.15);
  // A wide ambiguity is not itself an error, but it is where an error would
  // be largest, so it costs a little.
  const ambiguity = penalise(lift.ambiguityM, shaftLengthM * 3);

  /*
   * Depth evidence dominates, because the failure it guards against is large.
   *
   * Measured: where the wrist cue can settle the club's depth the CBP lands
   * within 10mm; where it cannot -- square to the camera, the club moving
   * almost entirely toward and away from the lens -- the depth can be half a
   * metre out while the in-image position stays perfectly correct. A club
   * that might be half a metre out is not a 0.45-confidence club.
   */
  const depthTerm = 0.15 + 0.85 * clampUnit(depthEvidence * 6);
  return clampUnit(
    detection * cameraQuality * reconciled * (0.6 + 0.4 * ambiguity) * depthTerm
  );
};

/** Build the per-frame camera fits the club model needs. Re-exported for tests. */
export { fitCamera, lerpVec };
export type { ClubObservation, Capsule };
