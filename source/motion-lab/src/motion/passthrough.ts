/**
 * The naive baseline: observations copied straight into ClarityFrames.
 *
 * NO RECONSTRUCTION HAPPENS HERE. A joint the detector missed is marked
 * `missing` and left missing. Nothing is smoothed, nothing is bridged,
 * nothing is inferred from the frames either side.
 *
 * It exists for two reasons, both worth the file:
 *
 *   1. It completes the pipeline today. Video -> detector -> 3D Space works
 *      end to end before the Motion Layer exists, which means the renderer,
 *      the anchoring and the detector wiring can all be exercised against
 *      real footage without waiting for the hard part.
 *
 *   2. It is the control. When the real Motion Layer lands, "is the
 *      reconstruction actually better?" has a concrete answer, because this
 *      is what NOT reconstructing looks like on the same input. Without a
 *      baseline, a reconstruction can only be judged on whether it looks
 *      nice -- and looking nice is exactly what the plan warns against
 *      optimising for.
 */

import type {
  BodyPose,
  ClarityFrame,
  ClarityJoint,
  ClaritySequence,
  ClarityStructure,
  ConfidenceComponents,
  JointProvenance,
  RigidStructure,
  Unit,
  Vec3,
} from "../contracts";
import {
  CLARITY_JOINTS,
  JOINTS_BY_STRUCTURE,
  RIGID_BONES,
  boneKey,
  centroid,
  clampUnit,
  distance,
  lerpVec,
  qIdentity,
} from "../contracts";
import type { WorldObservationSequence } from "../observe/observation";
import { buildFrameConfidence, penalise, PENALTY_SCALES } from "./confidence/confidence";
import { estimateMass } from "./mass/massModel";
import { checkableBodies, checkMassAgainstShape } from "./mass/massSanity";
import { buildPelvis, buildThorax } from "./body/structures";

const EMPTY_STRUCTURE: RigidStructure = {
  centre: [0, 0, 0],
  orientation: qIdentity(),
  halfExtents: [0.001, 0.001, 0.001],
  support: 0,
};

/** Median of whatever was actually measurable. Nulls are absences, not zeroes. */
const medianOf = (values: readonly (number | null)[]): number => {
  const usable = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (usable.length === 0) return 0;
  usable.sort((a, b) => a - b);
  return usable[Math.floor(usable.length / 2)];
};

/**
 * Measure this golfer's bone lengths from the frames that saw both ends.
 *
 * The median, not the mean: a single frame where a wrist was detected on the
 * background drags a mean forearm by centimetres, and there is no reason to
 * let it. The median simply ignores it.
 */
const measureBodyModel = (sequence: WorldObservationSequence): ClaritySequence["bodyModel"] => {
  const boneLengths: Record<string, number> = {};
  const boneConfidence: Record<string, number> = {};
  let samples = 0;

  for (const bone of RIGID_BONES) {
    const lengths: number[] = [];
    for (const frame of sequence.frames) {
      const from = frame.joints[bone.from];
      const to = frame.joints[bone.to];
      if (!from || !to) continue;
      lengths.push(distance(from.position as Vec3, to.position as Vec3));
    }

    const key = boneKey(bone);
    if (lengths.length === 0) {
      boneLengths[key] = 0;
      boneConfidence[key] = 0;
      continue;
    }
    lengths.sort((a, b) => a - b);
    boneLengths[key] = lengths[Math.floor(lengths.length / 2)];
    // Confidence in a length is how much of the clip agreed on it.
    boneConfidence[key] = clampUnit(lengths.length / Math.max(1, sequence.frames.length));
    samples = Math.max(samples, lengths.length);
  }

  /*
   * Standing height, from the chain that was actually measured.
   *
   * The torso link is NOT in boneLengths -- it is deliberately non-rigid,
   * because thorax-to-pelvis separation genuinely changes with flexion, so
   * pinning it would manufacture stability the observations do not support.
   * It therefore has to be measured here rather than looked up, and the first
   * version of this quietly read a zero and reported a 1.05m golfer.
   */
  const shin = boneLengths["leftKnee~leftAnkle"] || boneLengths["rightKnee~rightAnkle"] || 0;
  const thigh = boneLengths["leftHip~leftKnee"] || boneLengths["rightHip~rightKnee"] || 0;
  const headToNeck = boneLengths["head~neck"] || 0;
  const torso = medianOf(
    sequence.frames.map((frame) => {
      const leftHip = frame.joints.leftHip;
      const rightHip = frame.joints.rightHip;
      const leftShoulder = frame.joints.leftShoulder;
      const rightShoulder = frame.joints.rightShoulder;
      if (!leftHip || !rightHip || !leftShoulder || !rightShoulder) return null;
      const hipMid = lerpVec(leftHip.position as Vec3, rightHip.position as Vec3, 0.5);
      const shoulderMid = lerpVec(
        leftShoulder.position as Vec3,
        rightShoulder.position as Vec3,
        0.5
      );
      return distance(hipMid, shoulderMid);
    })
  );

  // The ground is Y = 0 after anchoring, so ankle height is simply where the
  // ankle sits.
  const ankleHeight = medianOf(
    sequence.frames.flatMap((frame) =>
      [frame.joints.leftAnkle, frame.joints.rightAnkle].map(
        (joint) => joint?.position[1] ?? null
      )
    )
  );

  const headMarkerHeight = ankleHeight + shin + thigh + torso + headToNeck;

  /*
   * The one ratio in this function, for the only part no detector can see:
   * the top of the skull. BlazePose's highest landmarks are the ears, so the
   * head marker sits at the centre of the cranium, which is about 93.5% of
   * standing height. Everything below it was measured on this golfer.
   */
  const HEAD_MARKER_FRACTION_OF_HEIGHT = 0.935;
  const estimated = headMarkerHeight / HEAD_MARKER_FRACTION_OF_HEIGHT;

  return {
    boneLengths,
    boneConfidence,
    // `estimated` is already a height. A body that was never fully seen would
    // report an absurd one and scale the whole scene by it, so 1.75m stands in
    // -- an admission of ignorance, not a measurement, and only when the chain
    // failed to measure.
    estimatedHeightM: estimated > 1 && estimated < 2.6 ? estimated : 1.75,
    sampleCount: samples,
  };
};

export const passthroughSequence = (
  sequence: WorldObservationSequence
): ClaritySequence => {
  const bodyModel = measureBodyModel(sequence);

  const frames: ClarityFrame[] = sequence.frames.map((observation) => {
    const joints = {} as Record<ClarityJoint, Vec3>;
    const provenance = {} as Record<ClarityJoint, JointProvenance>;
    const support: Partial<Record<ClarityJoint, Unit>> = {};

    const seen: Vec3[] = [];
    for (const joint of CLARITY_JOINTS) {
      const observed = observation.joints[joint];
      if (observed) seen.push(observed.position as Vec3);
    }
    // Somewhere neutral to put a joint that was never seen. Not a guess at
    // where it was -- its provenance says `missing`, and the renderer skips
    // bones that touch a missing joint rather than drawing one to here.
    const fallback: Vec3 = seen.length > 0 ? centroid(seen) : [0, 0, 0];

    let observedCount = 0;
    for (const joint of CLARITY_JOINTS) {
      const observed = observation.joints[joint];
      if (observed) {
        observedCount += 1;
        joints[joint] = observed.position as Vec3;
        support[joint] = observed.visibility;
        provenance[joint] = {
          source: "observed",
          correctionM: 0,
          framesSinceObserved: 0,
          gapLength: 0,
          rawConfidence: observed.visibility,
        };
      } else {
        joints[joint] = fallback;
        support[joint] = 0;
        provenance[joint] = {
          source: "missing",
          correctionM: 0,
          framesSinceObserved: 0,
          gapLength: 0,
          rawConfidence: 0,
        };
      }
    }

    const observedFraction = observedCount / CLARITY_JOINTS.length;
    const structureInput = { joints, support };

    const components: ConfidenceComponents = {
      directObservation: observedFraction,
      // Continuity, jumps and gaps are all questions about the relationship
      // BETWEEN frames, and a passthrough has no opinion about that -- it
      // never looks at another frame. Reporting anything other than the
      // observation rate here would be inventing a number.
      trackingContinuity: observedFraction,
      jumpCorrection: 1,
      gapReconstruction: observedFraction,
      bodyConstraintCorrection: 1,
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
              structureJoints.reduce((sum, joint) => sum + (support[joint] ?? 0), 0) /
                structureJoints.length
            );
    }

    const body: BodyPose = {
      joints,
      thorax: buildThorax(structureInput) ?? EMPTY_STRUCTURE,
      pelvis: buildPelvis(structureInput) ?? EMPTY_STRUCTURE,
    };

    return {
      index: observation.index,
      timestampMs: observation.timestampMs,
      body,
      // No club evidence has been established. Null says so; a CBP invented
      // from the hands alone would be a claim this layer cannot support.
      club: null,
      mass:
        observedCount >= CLARITY_JOINTS.length * 0.6
          ? estimateMass({
              joints,
              stanceWidthM: sequence.anchor.stanceWidthM,
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
  });

  const mean = (pick: (frame: ClarityFrame) => number) =>
    frames.length === 0 ? 0 : frames.reduce((sum, frame) => sum + pick(frame), 0) / frames.length;

  // Run on the passthrough too, so the readout compares like with like: the
  // check is about the camera and the golfer, not about how much
  // reconstruction happened, and it should say the same thing either way.
  const checkable = checkableBodies(frames);

  return {
    frames,
    fps: sequence.fps,
    bodyModel,
    anchor: sequence.anchor,
    massSanity: checkable.length > 0 ? checkMassAgainstShape(checkable, bodyModel.estimatedHeightM) : null,
    confidence: {
      overall: mean((frame) => frame.confidence.overall),
      components: {
        directObservation: mean((f) => f.confidence.components.directObservation),
        trackingContinuity: mean((f) => f.confidence.components.trackingContinuity),
        jumpCorrection: mean((f) => f.confidence.components.jumpCorrection),
        gapReconstruction: mean((f) => f.confidence.components.gapReconstruction),
        bodyConstraintCorrection: mean((f) => f.confidence.components.bodyConstraintCorrection),
        clubPoint: 0,
      },
      reconstructedFrameFraction: clampUnit(
        frames.filter((frame) => frame.provenance.observedFraction < 1).length /
          Math.max(1, frames.length)
      ),
      // A passthrough bridges nothing, so it has no gaps -- it has holes. The
      // distinction matters: zero here means "nothing was reconstructed", not
      // "nothing was missing".
      largestGapFrames: 0,
    },
    source: `passthrough:${sequence.detector}`,
  };
};

export { penalise, PENALTY_SCALES };
