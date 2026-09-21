/**
 * The Clarity Motion Layer.
 *
 * Observations in, ClarityFrames out. The order of operations is the design,
 * so it is worth stating why it is this order:
 *
 *   1. MEASURE THE BODY. Everything downstream needs this golfer's real bone
 *      lengths, and they are measured from the frames that saw both ends.
 *
 *   2. VALIDATE RETURNING OBSERVATIONS. A joint reappearing somewhere the
 *      rest of the body contradicts is rejected before it can do damage.
 *      This comes BEFORE gap bridging because a bridge lands exactly on its
 *      endpoint -- so a bad endpoint does not merely add one wrong frame, it
 *      drags the entire reconstructed span toward it.
 *
 *   3. REJECT ISOLATED JUMPS, by second difference, never by speed.
 *
 *   4. BRIDGE GAPS using both sides.
 *
 *   5. ENFORCE PHYSICAL CONSTRAINTS per frame, with the better-known joint
 *      yielding less.
 *
 *   6. SMOOTH, by evidence, with a fit that preserves acceleration exactly.
 *
 *   7. SCORE what all of that cost, per structure and overall.
 *
 * Nothing in here knows what a golf swing looks like. There is no swing
 * plane, no expected hand path, no assumed sequencing. The only assumptions
 * are physical: bones keep their length, connected joints stay connected,
 * and things do not teleport.
 */

import type {
  BodyPose,
  ClarityFrame,
  ClarityJoint,
  ClaritySequence,
  ClarityStructure,
  ConfidenceComponents,
  JointProvenance,
  ProvenanceSource,
  RigidStructure,
  Unit,
  Vec3,
} from "../../contracts";
import {
  CLARITY_JOINTS,
  JOINTS_BY_STRUCTURE,
  add,
  centroid,
  clampUnit,
  distance,
  qIdentity,
  scale,
  sub,
} from "../../contracts";
import type { WorldObservationSequence } from "../../observe/observation";
import { buildFrameConfidence, penalise, PENALTY_SCALES } from "../confidence/confidence";
import { estimateMass } from "../mass/massModel";
import { buildPelvis, buildThorax } from "../body/structures";
import { measureBodyModel, type MeasuredBodyModel } from "./bodyModel";
import { applyConstraints, structuralDisagreement } from "./constraints";
import { bridgeGap } from "./gaps";
import { findJumps, repairJump } from "./jumps";
import { ReacquisitionTracker, supportFromDisagreement } from "./reacquisition";
import { smoothTrack } from "./smoothing";
import { buildTracks, estimateNoise, findGaps, type Tracks } from "./tracks";

const EMPTY_STRUCTURE: RigidStructure = {
  centre: [0, 0, 0],
  orientation: qIdentity(),
  halfExtents: [0.001, 0.001, 0.001],
  support: 0,
};

export interface ReconstructOptions {
  /** Turn individual stages off, to see what each one is actually buying. */
  readonly stages?: {
    readonly rejectJumps?: boolean;
    readonly validateReacquisition?: boolean;
    readonly bridgeGaps?: boolean;
    readonly constrain?: boolean;
    readonly smooth?: boolean;
  };
}

/** What happened to one joint on one frame, before it becomes provenance. */
interface Cell {
  position: Vec3;
  source: ProvenanceSource;
  trust: Unit;
  rawConfidence: Unit;
  correctionM: number;
  framesSinceObserved: number;
  gapLength: number;
  /** How much the smoother is allowed to move this sample. */
  smoothingStrength: number;
}

export interface ReconstructionReport {
  readonly sequence: ClaritySequence;
  /** Per joint: how many samples each stage touched. For the debug panel. */
  readonly stageCounts: Readonly<Record<string, number>>;
  readonly bodyModel: MeasuredBodyModel;
}

export const reconstruct = (
  observations: WorldObservationSequence,
  options: ReconstructOptions = {}
): ReconstructionReport => {
  const stages = {
    rejectJumps: true,
    validateReacquisition: true,
    bridgeGaps: true,
    constrain: true,
    smooth: true,
    ...options.stages,
  };

  const frameCount = observations.frames.length;
  const tracks = buildTracks(observations);
  const model = measureBodyModel(tracks, frameCount);
  const heightM = model.estimatedHeightM;

  const stageCounts: Record<string, number> = {
    jumpsRejected: 0,
    reacquisitionsDoubted: 0,
    framesBridged: 0,
    framesExtrapolated: 0,
    framesMissing: 0,
    constraintViolations: 0,
  };

  /* ------------------------------------------------------------------ *
   * 2. Validate returning observations against the rest of the body
   * ------------------------------------------------------------------ */

  if (stages.validateReacquisition) {
    stageCounts.reacquisitionsDoubted = rejectUnsupportedReturns(
      tracks,
      model,
      frameCount,
      heightM
    );
  }

  /* ------------------------------------------------------------------ *
   * 3 & 4. Reject isolated jumps, then bridge what is left
   * ------------------------------------------------------------------ */

  const cells = {} as Record<ClarityJoint, Cell[]>;

  for (const joint of CLARITY_JOINTS) {
    const track = tracks[joint];
    const jumpReport = stages.rejectJumps
      ? findJumps(track, {
          heightM,
          // A surprising sample is only rejected if the body also disagrees.
          isStructurallyImplausible: (frame) =>
            bodyContradicts(joint, frame, tracks, model, heightM),
        })
      : { flags: new Map(), scaleM: 0, thresholdM: Number.POSITIVE_INFINITY };

    /*
     * How hard to smooth this joint, measured rather than asked for.
     *
     * The detector's own `visibility` is not a noise estimate: it stays at
     * 0.9-plus while the positions jitter by centimetres, so deriving
     * smoothing strength from it produced a strength of 0.05 on visibly noisy
     * data -- the filter was switched off precisely when it was needed.
     *
     * The noise is therefore measured off the track itself. A clean joint
     * gets essentially no smoothing; a noisy one gets a lot; and neither
     * depends on how fast the joint happens to be moving.
     */
    const noiseM = estimateNoise(track);
    const noiseStrength = clampUnit(0.08 + (noiseM / (heightM * 0.012)) * 0.6);

    const column: Cell[] = new Array(frameCount);

    // Observed samples first, repairing any that were flagged.
    for (let index = 0; index < frameCount; index += 1) {
      const sample = track.samples[index];
      if (!sample) continue;

      const flag = jumpReport.flags.get(index);
      const repaired = flag ? repairJump(track, index) : null;
      if (flag && repaired) stageCounts.jumpsRejected += 1;

      const position = repaired ?? sample.position;
      column[index] = {
        position,
        source: repaired ? "constrained" : "observed",
        trust: repaired ? clampUnit(sample.visibility * 0.5) : sample.visibility,
        rawConfidence: sample.visibility,
        correctionM: repaired ? distance(repaired, sample.position) : 0,
        framesSinceObserved: 0,
        gapLength: 0,
        // A confidently observed sample is barely touched; the smoother's
        // job is the weak ones. An outlier we already replaced gets pulled
        // hard, because its neighbours are all the evidence there is.
        smoothingStrength: repaired ? 0.75 : Math.max(noiseStrength, clampUnit((1 - sample.visibility) * 0.6)),
      };
    }

    // Then the holes.
    for (const gap of findGaps(track)) {
      const bridge = stages.bridgeGaps
        ? bridgeGap(track, gap)
        : { points: [], kind: "unbridged" as const, tangentWeight: 0 };

      for (let offset = 0; offset < gap.length; offset += 1) {
        const index = gap.start + offset;
        const point = bridge.points[offset];

        if (!point) {
          // Nothing to say. Somewhere neutral, marked missing, and the
          // renderer draws no bone to it.
          stageCounts.framesMissing += 1;
          column[index] = {
            position: [0, 0, 0],
            source: "missing",
            trust: 0,
            rawConfidence: 0,
            correctionM: 0,
            framesSinceObserved: offset + 1,
            gapLength: gap.length,
            smoothingStrength: 0,
          };
          continue;
        }

        const bridged = bridge.kind === "bridged";
        if (bridged) stageCounts.framesBridged += 1;
        else stageCounts.framesExtrapolated += 1;

        /*
         * Trust falls with depth into the gap, and a bridge starts from a far
         * better place than an extrapolation: it is constrained at both ends,
         * so its middle is genuinely informed rather than merely continued.
         */
        const depthPenalty = penalise(point.depth, PENALTY_SCALES.gapFrames);
        column[index] = {
          position: point.position,
          source: bridged ? "reconstructed" : "extrapolated",
          trust: clampUnit((bridged ? 0.55 : 0.18) * depthPenalty),
          rawConfidence: 0,
          correctionM: 0,
          framesSinceObserved: offset + 1,
          gapLength: gap.length,
          smoothingStrength: bridged ? 0.35 : 0.2,
        };
      }
    }

    // A track that was never seen at all still needs a column.
    for (let index = 0; index < frameCount; index += 1) {
      if (column[index]) continue;
      column[index] = {
        position: [0, 0, 0],
        source: "missing",
        trust: 0,
        rawConfidence: 0,
        correctionM: 0,
        framesSinceObserved: index + 1,
        gapLength: frameCount,
        smoothingStrength: 0,
      };
    }

    cells[joint] = column;
  }

  /* ------------------------------------------------------------------ *
   * Put missing joints somewhere neutral rather than at the world origin
   * ------------------------------------------------------------------ */

  for (let index = 0; index < frameCount; index += 1) {
    const placed: Vec3[] = [];
    for (const joint of CLARITY_JOINTS) {
      if (cells[joint][index].source !== "missing") placed.push(cells[joint][index].position);
    }
    if (placed.length === 0) continue;
    const neutral = centroid(placed);
    for (const joint of CLARITY_JOINTS) {
      const cell = cells[joint][index];
      if (cell.source === "missing") cell.position = neutral;
    }
  }

  /* ------------------------------------------------------------------ *
   * 5 & 6. Constrain, smooth, then constrain again
   *
   * The order is not cosmetic. Smoothing moves joints independently along
   * their own tracks, so it does not know about bones and will happily pull a
   * wrist 16mm out of an 81mm hand segment -- which is what the first version
   * shipped, because it constrained and then smoothed. A constraint pass has
   * to come LAST if the output is to satisfy the constraints at all.
   *
   * The first pass still earns its place: it repairs the geometry before
   * smoothing sees it, so the smoother is fitting a body rather than fitting
   * the damage.
   * ------------------------------------------------------------------ */

  const constrainPass = () => {
    for (let index = 0; index < frameCount; index += 1) {
      const joints = {} as Record<ClarityJoint, Vec3>;
      const trust = {} as Record<ClarityJoint, Unit>;
      for (const joint of CLARITY_JOINTS) {
        joints[joint] = cells[joint][index].position;
        // A joint nobody located must not anchor a bone. Zero trust makes it
        // yield completely rather than dragging a real joint to meet it.
        trust[joint] =
          cells[joint][index].source === "missing" ? 0 : cells[joint][index].trust;
      }

      const solved = applyConstraints({ joints, trust, model });
      stageCounts.constraintViolations += solved.violations.size;

      for (const joint of CLARITY_JOINTS) {
        const cell = cells[joint][index];
        if (cell.source === "missing") continue;
        cell.correctionM += solved.correctionM[joint];
        cell.position = solved.joints[joint];
        // Being moved by a constraint is itself a fact about the frame.
        if (cell.source === "observed" && solved.correctionM[joint] > heightM * 0.01) {
          cell.source = "constrained";
        }
      }
    }
  };

  if (stages.constrain) constrainPass();

  if (stages.smooth) {
    for (const joint of CLARITY_JOINTS) {
      const column = cells[joint];
      const result = smoothTrack({
        positions: column.map((cell) => cell.position),
        trust: column.map((cell) => cell.trust),
        strength: column.map((cell) =>
          cell.source === "missing" ? 0 : cell.smoothingStrength
        ),
      });
      for (let index = 0; index < frameCount; index += 1) {
        column[index].position = result.positions[index];
        column[index].correctionM += result.correctionM[index];
      }
    }
    // Smoothing knows nothing about bones. Project back onto them.
    if (stages.constrain) constrainPass();
  }

  /* ------------------------------------------------------------------ *
   * 7. Assemble
   * ------------------------------------------------------------------ */

  const frames = observations.frames.map((observation, index) =>
    assembleFrame(observation.timestampMs, index, cells, observations, heightM)
  );

  return {
    bodyModel: model,
    stageCounts,
    sequence: {
      frames,
      fps: observations.fps,
      bodyModel: model,
      anchor: observations.anchor,
      confidence: summarise(frames),
      source: `clarity-motion-layer:${observations.detector}`,
    },
  };
};


/**
 * Does the rest of the body say this sample cannot be where it claims?
 *
 * Measures the sample against the bones connecting it to joints observed in
 * the same frame. A real detection error breaks them; a fast but genuine
 * movement does not, because a body cannot move in a way that changes its own
 * bone lengths.
 *
 * With no confident neighbour there is no second opinion, so the answer is
 * "yes, go by the deviation alone" -- the alternative would be to excuse
 * every outlier on a poorly-tracked limb.
 */
const bodyContradicts = (
  joint: ClarityJoint,
  frame: number,
  tracks: Tracks,
  model: MeasuredBodyModel,
  heightM: number
): boolean => {
  const sample = tracks[joint].samples[frame];
  if (!sample) return false;

  const joints = {} as Record<ClarityJoint, Vec3>;
  const trust = {} as Record<ClarityJoint, Unit>;
  for (const other of CLARITY_JOINTS) {
    const otherSample = tracks[other].samples[frame];
    joints[other] = otherSample?.position ?? [0, 0, 0];
    trust[other] = otherSample ? otherSample.visibility : 0;
  }

  const { disagreementM, neighboursUsed } = structuralDisagreement(
    joint,
    sample.position,
    joints,
    trust,
    model
  );
  if (neighboursUsed === 0) return true;

  // Per connected bone. Detection noise puts a bone a few millimetres out;
  // 4% of standing height -- about 70mm on a 1.8m golfer -- is a broken limb.
  return disagreementM / neighboursUsed > heightM * 0.04;
};

/* ------------------------------------------------------------------ *
 * Reacquisition validation
 * ------------------------------------------------------------------ */

/**
 * Reject RETURNING observations the rest of the body contradicts.
 *
 * "Returning" is the whole scope, and getting that wrong is expensive. The
 * first version judged every observation against the previous frame's
 * position, which is not a prediction -- it is where the joint used to be. A
 * hand travelling at 9 m/s moves 150mm between frames at 60fps, so on
 * perfectly clean data the fastest part of the swing looked like a joint
 * teleporting and got rejected wholesale. The reconstruction then had to
 * bridge gaps it had created itself, and came out worse than doing nothing.
 *
 * So a joint that was seen last frame is simply tracked. Only a joint that
 * was MISSING and has come back is judged -- which is exactly the case the
 * plan describes.
 *
 * A return is judged against a prediction that carries the last known
 * velocity forward, and against a tolerance widened by how far the joint
 * could plausibly have travelled while unseen. Both matter: a stale
 * prediction is weak evidence, and treating it as strong would reject every
 * recovery from a long gap.
 *
 * Returns how many samples were rejected.
 */
const rejectUnsupportedReturns = (
  tracks: Tracks,
  model: MeasuredBodyModel,
  frameCount: number,
  heightM: number
): number => {
  const tracker = new ReacquisitionTracker({ heightM });
  let rejected = 0;

  // The model's running belief, and how fast it was last going. Carried
  // through gaps -- that continuity IS the persistent body model, and it is
  // what a return is judged against.
  const believed: Partial<Record<ClarityJoint, Vec3>> = {};
  const velocity: Partial<Record<ClarityJoint, Vec3>> = {};
  const missingFor: Partial<Record<ClarityJoint, number>> = {};

  // How far a stale prediction may be extrapolated. Beyond a few frames a
  // measured velocity says very little, and running with it would put the
  // prediction somewhere no evidence supports.
  const MAX_EXTRAPOLATION_FRAMES = 3;

  for (let index = 0; index < frameCount; index += 1) {
    // Structural evidence for this frame. Built from observations where they
    // exist and beliefs where they do not, so a joint is judged against the
    // reconstruction rather than against other detections that may be equally
    // wrong.
    const joints = {} as Record<ClarityJoint, Vec3>;
    const trust = {} as Record<ClarityJoint, Unit>;
    for (const joint of CLARITY_JOINTS) {
      const sample = tracks[joint].samples[index];
      joints[joint] = sample?.position ?? believed[joint] ?? [0, 0, 0];
      trust[joint] = sample ? sample.visibility : 0;
    }

    for (const joint of CLARITY_JOINTS) {
      const sample = tracks[joint].samples[index];
      if (!sample) {
        missingFor[joint] = (missingFor[joint] ?? 0) + 1;
        tracker.forget(joint);
        continue;
      }

      const previous = believed[joint];
      const gone = missingFor[joint] ?? 0;

      // Nothing to disagree with yet, or the joint never went away: track it.
      if (!previous || gone === 0) {
        if (previous) velocity[joint] = sub(sample.position, previous);
        believed[joint] = sample.position;
        missingFor[joint] = 0;
        continue;
      }

      const carried = velocity[joint] ?? [0, 0, 0];
      const steps = Math.min(gone, MAX_EXTRAPOLATION_FRAMES);
      const predicted = add(previous, scale(carried, steps));
      // How far it could plausibly have gone while unseen, at the speed it
      // was last doing.
      const slack = Math.hypot(carried[0], carried[1], carried[2]) * gone;

      const { disagreementM, neighboursUsed } = structuralDisagreement(
        joint,
        sample.position,
        joints,
        trust,
        model
      );
      const support = supportFromDisagreement(disagreementM, neighboursUsed, heightM);
      const judgement = tracker.judge(joint, sample.position, predicted, support, slack);

      if (judgement.verdict === "doubted") {
        // Not accepted as an observation. It stays in the tracker, so if it
        // keeps saying the same thing it is promoted within a few frames --
        // the plan's "require consistent evidence" rule.
        tracks[joint].samples[index] = null;
        missingFor[joint] = gone + 1;
        rejected += 1;
        continue;
      }

      // Confirmed or reconciling: move the belief toward it by the allowed
      // amount rather than snapping, so a moderate disagreement is absorbed
      // over several frames.
      const blended: Vec3 = [
        predicted[0] + (sample.position[0] - predicted[0]) * judgement.blend,
        predicted[1] + (sample.position[1] - predicted[1]) * judgement.blend,
        predicted[2] + (sample.position[2] - predicted[2]) * judgement.blend,
      ];
      velocity[joint] = scale(sub(blended, previous), 1 / Math.max(1, gone));
      believed[joint] = blended;
      missingFor[joint] = 0;
    }
  }

  return rejected;
};

/* ------------------------------------------------------------------ *
 * Frame assembly
 * ------------------------------------------------------------------ */

const assembleFrame = (
  timestampMs: number,
  index: number,
  cells: Record<ClarityJoint, Cell[]>,
  observations: WorldObservationSequence,
  heightM: number
): ClarityFrame => {
  const joints = {} as Record<ClarityJoint, Vec3>;
  const provenance = {} as Record<ClarityJoint, JointProvenance>;
  const support: Partial<Record<ClarityJoint, Unit>> = {};

  let observedCount = 0;
  let correctionTotal = 0;
  let gapTotal = 0;
  let largestGap = 0;

  for (const joint of CLARITY_JOINTS) {
    const cell = cells[joint][index];
    joints[joint] = cell.position;
    support[joint] = cell.trust;

    if (cell.source === "observed") observedCount += 1;
    correctionTotal += cell.correctionM;
    gapTotal += cell.gapLength;
    largestGap = Math.max(largestGap, cell.gapLength);

    provenance[joint] = {
      source: cell.source,
      correctionM: cell.correctionM,
      framesSinceObserved: cell.framesSinceObserved,
      gapLength: cell.gapLength,
      rawConfidence: cell.rawConfidence,
    };
  }

  const observedFraction = observedCount / CLARITY_JOINTS.length;
  const structureInput = { joints, support };

  /*
   * Per-joint penalties, blended half on the average and half on the worst.
   *
   * A plain average dilutes a serious local failure into nothing: one joint
   * bridged across sixteen frames, among twenty joints, scores 0.96 -- as if
   * inventing a limb for a quarter of a second were a four per cent event. A
   * plain minimum is the opposite mistake, letting one weak joint condemn a
   * frame that is otherwise perfectly observed.
   *
   * Half and half keeps both facts visible, and is why the components move
   * over the range the plan's worked example shows rather than sitting near
   * 100 whatever happens.
   */
  const blendWorst = (penalties: readonly number[]): Unit => {
    if (penalties.length === 0) return 1;
    const mean = penalties.reduce((sum, value) => sum + value, 0) / penalties.length;
    return clampUnit(mean * 0.5 + Math.min(...penalties) * 0.5);
  };

  const gapPenalties = CLARITY_JOINTS.map((joint) =>
    penalise(cells[joint][index].gapLength, PENALTY_SCALES.gapFrames)
  );
  const correctionPenalties = CLARITY_JOINTS.map((joint) =>
    penalise(cells[joint][index].correctionM, PENALTY_SCALES.constraintCorrectionM)
  );

  const components: ConfidenceComponents = {
    directObservation: observedFraction,
    // How continuous the track has been, as the mean trust across joints --
    // which already falls with depth into a gap.
    trackingContinuity: clampUnit(
      CLARITY_JOINTS.reduce((sum, joint) => sum + cells[joint][index].trust, 0) /
        CLARITY_JOINTS.length
    ),
    jumpCorrection: penalise(
      CLARITY_JOINTS.filter((joint) => cells[joint][index].source === "constrained").length *
        0.03,
      PENALTY_SCALES.jumpM
    ),
    gapReconstruction: blendWorst(gapPenalties),
    bodyConstraintCorrection: blendWorst(correctionPenalties),
    // No clubhead tracker exists yet, so there is no club evidence to score.
    // Zero is the absence of a claim, not a bad one.
    clubPoint: 0,
  };

  const structures = {} as Record<ClarityStructure, Unit>;
  for (const [structure, structureJoints] of Object.entries(JOINTS_BY_STRUCTURE) as [
    ClarityStructure,
    readonly ClarityJoint[],
  ][]) {
    structures[structure] =
      structureJoints.length === 0
        ? 0
        : clampUnit(
            structureJoints.reduce((sum, joint) => sum + cells[joint][index].trust, 0) /
              structureJoints.length
          );
  }

  const body: BodyPose = {
    joints,
    thorax: buildThorax(structureInput) ?? EMPTY_STRUCTURE,
    pelvis: buildPelvis(structureInput) ?? EMPTY_STRUCTURE,
  };

  return {
    index,
    timestampMs,
    body,
    // The CBP needs club evidence, and no clubhead tracker exists yet. An
    // estimate from the hands and an assumed length would be a claim this
    // layer cannot support.
    club: null,
    mass:
      observedCount + gapTotal > 0 && usableForMass(cells, index, heightM)
        ? estimateMass({
            joints,
            stanceWidthM: observations.anchor.stanceWidthM,
            jointSupport: support,
          })
        : null,
    confidence: buildFrameConfidence(components, structures),
    provenance: {
      joints: provenance,
      observedFraction,
      wholeFrameReconstructed: observedCount === 0,
    },
  };
};

/**
 * Mass needs a body to distribute over.
 *
 * The test is on the FEET and the TRUNK specifically, not on a joint count:
 * the support estimate is meaningless without foot geometry, and the upper
 * mass map is meaningless without hips and shoulders. Twenty joints of arms
 * would pass a count and produce nonsense.
 */
const usableForMass = (
  cells: Record<ClarityJoint, Cell[]>,
  index: number,
  _heightM: number
): boolean => {
  const required: ClarityJoint[] = [
    "leftHip",
    "rightHip",
    "leftShoulder",
    "rightShoulder",
    "leftHeel",
    "rightHeel",
    "leftToe",
    "rightToe",
  ];
  return required.every((joint) => cells[joint][index].source !== "missing");
};

const summarise = (frames: readonly ClarityFrame[]) => {
  const count = Math.max(1, frames.length);
  const mean = (pick: (frame: ClarityFrame) => number) =>
    frames.reduce((sum, frame) => sum + pick(frame), 0) / count;

  let largestGapFrames = 0;
  let reconstructedFrames = 0;
  for (const frame of frames) {
    if (frame.provenance.observedFraction < 1) reconstructedFrames += 1;
    for (const joint of CLARITY_JOINTS) {
      largestGapFrames = Math.max(largestGapFrames, frame.provenance.joints[joint].gapLength);
    }
  }

  return {
    overall: mean((frame) => frame.confidence.overall),
    components: {
      directObservation: mean((f) => f.confidence.components.directObservation),
      trackingContinuity: mean((f) => f.confidence.components.trackingContinuity),
      jumpCorrection: mean((f) => f.confidence.components.jumpCorrection),
      gapReconstruction: mean((f) => f.confidence.components.gapReconstruction),
      bodyConstraintCorrection: mean((f) => f.confidence.components.bodyConstraintCorrection),
      clubPoint: 0,
    },
    reconstructedFrameFraction: clampUnit(reconstructedFrames / count),
    largestGapFrames,
  };
};
