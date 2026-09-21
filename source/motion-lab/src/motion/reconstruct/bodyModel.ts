/**
 * The persistent body model: this golfer's measured geometry.
 *
 * This is what makes "a femur does not suddenly change length" enforceable.
 * The constraint is useless without knowing how long THIS femur is, and the
 * plan is firm that the answer comes from observation rather than from a
 * population table.
 *
 * Every length here is a median over the frames that saw both ends. Not a
 * mean: the frames worth ignoring are exactly the ones that would drag a
 * mean, and a single detection landing on the background can add ten
 * centimetres to a forearm. The median simply does not see it.
 *
 * WHAT MAKES A FRAME WORTH MEASURING FROM
 *
 * Both ends observed, both with real visibility. Nothing about the pose --
 * no requirement that the golfer be at address or standing still, because
 * that would be a golf assumption and bone lengths do not care what the body
 * is doing.
 */

import type { BodyModel, Metres, Unit } from "../../contracts";
import { RIGID_BONES, boneKey, clampUnit, distance, lerpVec } from "../../contracts";
import type { Tracks } from "./tracks";
import { medianAbsoluteDeviation, medianOf } from "./tracks";

/** Below this the detector is guessing, and a length measured from it is too. */
const MEASURE_VISIBILITY_FLOOR = 0.5;

export interface MeasuredBone {
  readonly key: string;
  readonly lengthM: Metres;
  readonly confidence: Unit;
  /** Spread of the measurements. A tight spread means a real, rigid segment. */
  readonly spreadM: Metres;
  readonly sampleCount: number;
}

export interface MeasuredBodyModel extends BodyModel {
  readonly bones: Readonly<Record<string, MeasuredBone>>;
}

export const measureBodyModel = (
  tracks: Tracks,
  frameCount: number
): MeasuredBodyModel => {
  const bones: Record<string, MeasuredBone> = {};
  const boneLengths: Record<string, number> = {};
  const boneConfidence: Record<string, number> = {};
  let maxSamples = 0;

  for (const bone of RIGID_BONES) {
    const key = boneKey(bone);
    const from = tracks[bone.from].samples;
    const to = tracks[bone.to].samples;

    const lengths: number[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const a = from[index];
      const b = to[index];
      if (!a || !b) continue;
      if (a.visibility < MEASURE_VISIBILITY_FLOOR) continue;
      if (b.visibility < MEASURE_VISIBILITY_FLOOR) continue;
      lengths.push(distance(a.position, b.position));
    }

    const lengthM = medianOf(lengths);
    const spreadM = medianAbsoluteDeviation(lengths);

    /*
     * Confidence in a length has two parts, and both matter.
     *
     * Coverage: how much of the clip agreed. A length from four frames is a
     * guess however tight those four agree.
     *
     * Tightness: how much the measurements varied RELATIVE TO THE LENGTH
     * itself. A femur measured to plus or minus 5mm is solid; a forearm
     * varying by 5cm is telling us the detector never really had a fix on the
     * wrist, and the constraint solver should not lean on it.
     */
    const coverage = clampUnit(lengths.length / Math.max(1, frameCount * 0.5));
    const tightness =
      lengthM > 1e-6 ? clampUnit(1 - spreadM / (lengthM * 0.25)) : 0;

    bones[key] = {
      key,
      lengthM,
      spreadM,
      sampleCount: lengths.length,
      confidence: clampUnit(coverage * 0.5 + tightness * 0.5),
    };
    boneLengths[key] = lengthM;
    boneConfidence[key] = bones[key].confidence;
    maxSamples = Math.max(maxSamples, lengths.length);
  }

  return {
    bones,
    boneLengths,
    boneConfidence,
    estimatedHeightM: estimateHeight(tracks, boneLengths, frameCount),
    sampleCount: maxSamples,
  };
};

/**
 * Standing height, from the measured chain.
 *
 * The torso link is deliberately NOT a rigid bone -- thorax-to-pelvis
 * separation genuinely changes with flexion -- so it is measured here rather
 * than read from boneLengths, where it does not appear. Reading a zero from
 * there is an easy mistake that reports a one-metre golfer and scales the
 * whole scene by it.
 */
const estimateHeight = (
  tracks: Tracks,
  boneLengths: Record<string, number>,
  frameCount: number
): number => {
  const shin = boneLengths["leftKnee~leftAnkle"] || boneLengths["rightKnee~rightAnkle"] || 0;
  const thigh = boneLengths["leftHip~leftKnee"] || boneLengths["rightHip~rightKnee"] || 0;
  const headToNeck = boneLengths["head~neck"] || 0;

  const torsoSamples: number[] = [];
  const ankleHeights: number[] = [];

  for (let index = 0; index < frameCount; index += 1) {
    const leftHip = tracks.leftHip.samples[index];
    const rightHip = tracks.rightHip.samples[index];
    const leftShoulder = tracks.leftShoulder.samples[index];
    const rightShoulder = tracks.rightShoulder.samples[index];

    if (leftHip && rightHip && leftShoulder && rightShoulder) {
      torsoSamples.push(
        distance(
          lerpVec(leftHip.position, rightHip.position, 0.5),
          lerpVec(leftShoulder.position, rightShoulder.position, 0.5)
        )
      );
    }

    // The ground is Y = 0 after anchoring, so ankle height is where it sits.
    for (const ankle of [tracks.leftAnkle.samples[index], tracks.rightAnkle.samples[index]]) {
      if (ankle) ankleHeights.push(ankle.position[1]);
    }
  }

  const chain =
    medianOf(ankleHeights) + shin + thigh + medianOf(torsoSamples) + headToNeck;

  /*
   * One ratio, for the only part no detector can see: the top of the skull.
   * BlazePose's highest landmarks are the ears, so the head marker sits at the
   * centre of the cranium, about 93.5% of standing height. Everything below it
   * was measured on this golfer.
   */
  const estimated = chain / 0.935;
  return estimated > 1 && estimated < 2.6 ? estimated : 1.75;
};
