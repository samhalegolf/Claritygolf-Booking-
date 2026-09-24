/**
 * The far side, zeroed to a neutral stance down the line.
 *
 * THE PROBLEM
 *
 * Down the line the stance runs along the lens. Everything across the
 * picture is measured; everything along the target line is the detector's
 * guess at depth, and for the far leg -- seen past the near one, or not at
 * all -- that guess is poor and, worse, BIASED: the far knee and foot come
 * out splayed toward or away from the camera by the same amount frame after
 * frame. A bias is not noise. No smoother removes it, and the mass model
 * reads it as the golfer loading one foot.
 *
 * THE ZERO POINT
 *
 * With nothing able to see that dimension, it is assumed neutral at
 * address: weight 50/50, the body stacked normally, so the far leg sits in
 * depth where the near leg's mirror image about the hips would put it. That
 * is the zero point, not a hold. The offset it implies is measured once,
 * over the address window, and taken off every frame -- so whatever the
 * far leg does through the swing, as the detector saw it, still happens.
 * Only the constant part of the error goes.
 *
 * WHAT IS MOVED, AND HOW
 *
 * The far knee and ankle, each along its own line of sight, so it stays on
 * the pixel the detector found it at and only the guessed depth gives. The
 * heel and toe move with the ankle, by its offset: mirroring them one by one
 * would give the far foot the near foot's flare, and golfers flare the lead
 * foot more -- that is the foot's own shape, not a depth error. The hips
 * are left alone: they set the mirror, and their depth is the pelvis's, not
 * a leg's. Nothing across the picture changes.
 *
 * WHEN IT DOES NOTHING
 *
 * When the hips show a real width across the picture the clip is not down
 * the line -- the far leg is in view and its depth is not what is missing --
 * and the stage stands aside. That test uses only the across-picture part of
 * the hips, which is the part the detector measures well.
 *
 * WHAT WOULD PROVE OTHERWISE
 *
 * A second camera that sees the stance across its picture, or a marker the
 * user names later. Neither exists yet; `options.enabled` is the switch a
 * future face-on clip would turn off.
 */

import type { ClarityJoint, Vec3 } from "../../contracts";
import { add, dot, lerpVec, normalise, scale, sub } from "../../contracts";
import { medianOf, type Tracks } from "./tracks";

export type LegSide = "left" | "right";

export interface NeutralFarSideReport {
  /** Whether any joint was moved. */
  readonly applied: boolean;
  /** The leg zeroed, or null when the stage stood aside. */
  readonly farSide: LegSide | null;
  /** Per far joint, the depth offset taken off every frame, metres. + is away from the lens. */
  readonly shiftM: Readonly<Partial<Record<ClarityJoint, number>>>;
  /** The hips' width across the picture at address, metres. What decides "down the line". */
  readonly hipsAcrossM: number;
  readonly skipped: string | null;
}

export interface NeutralFarSideInput {
  /** Raw observations. Moved in place, before anything measures off them. */
  readonly tracks: Tracks;
  readonly cameras: readonly (Vec3 | null)[];
  readonly anchorFrameIndex: number;
  readonly fps: number;
  readonly heightM: number;
}

export interface NeutralFarSideOptions {
  readonly enabled?: boolean;
  readonly referenceWindowSeconds?: number;
  /**
   * Hips narrower than this across the picture, as a fraction of height,
   * count as down the line. Square hips are about a tenth of height wide;
   * this is them turned more than about fifty-five degrees toward the lens.
   */
  readonly maxHipsAcrossFraction?: number;
  /** Largest offset taken off, as a fraction of height. Past it the stance is not neutral. */
  readonly maxShiftFraction?: number;
}

const DEFAULTS = {
  enabled: true,
  referenceWindowSeconds: 0.25,
  maxHipsAcrossFraction: 0.06,
  maxShiftFraction: 0.25,
} as const;

const LEGS: Readonly<Record<LegSide, readonly ClarityJoint[]>> = {
  left: ["leftKnee", "leftAnkle", "leftHeel", "leftToe"],
  right: ["rightKnee", "rightAnkle", "rightHeel", "rightToe"],
};

/** Horizontal: depth along the target line is measured on the ground. */
const flat = (vector: Vec3): Vec3 => [vector[0], 0, vector[2]];

export const zeroFarSide = (
  input: NeutralFarSideInput,
  options: NeutralFarSideOptions = {}
): NeutralFarSideReport => {
  const settings = { ...DEFAULTS, ...options };
  const { tracks, cameras, heightM } = input;
  const none = (skipped: string, hipsAcrossM = 0): NeutralFarSideReport => ({
    applied: false,
    farSide: null,
    shiftM: {},
    hipsAcrossM,
    skipped,
  });
  if (!settings.enabled) return none("switched off");

  const frameCount = tracks.leftHip.samples.length;
  const half = Math.max(1, Math.round(input.fps * settings.referenceWindowSeconds));
  const from = Math.max(0, input.anchorFrameIndex - half);
  const to = Math.min(frameCount - 1, input.anchorFrameIndex + half);
  const camera = cameras[input.anchorFrameIndex] ?? cameras.find((entry) => entry !== null) ?? null;
  if (!camera) return none("no camera was fitted, so there is no line of sight to call depth");

  /*
   * The line of sight to the hips, laid flat: "depth" from here on means
   * distance along it. Down the line this is the target line.
   */
  const hipMids: Vec3[] = [];
  const hipSeps: Vec3[] = [];
  for (let index = from; index <= to; index += 1) {
    const left = tracks.leftHip.samples[index];
    const right = tracks.rightHip.samples[index];
    if (!left || !right) continue;
    hipMids.push(lerpVec(left.position, right.position, 0.5));
    hipSeps.push(sub(right.position, left.position));
  }
  if (hipMids.length === 0) return none("the hips were not seen at address");
  const median = (points: readonly Vec3[]): Vec3 => [
    medianOf(points.map((point) => point[0])),
    medianOf(points.map((point) => point[1])),
    medianOf(points.map((point) => point[2])),
  ];
  const hipMid = median(hipMids);
  const along = flat(sub(hipMid, camera));
  if (dot(along, along) < 1e-8) return none("the camera sits over the golfer");
  const u = normalise(along);

  const depth = (point: Vec3) => dot(sub(point, camera), u);
  const across = (vector: Vec3) => {
    const level = flat(vector);
    const inDepth = dot(level, u);
    const rest = sub(level, scale(u, inDepth));
    return Math.sqrt(dot(rest, rest));
  };

  const hipsAcrossM = medianOf(hipSeps.map(across));
  if (hipsAcrossM > heightM * settings.maxHipsAcrossFraction) {
    return none("the hips show their width across the picture, so this is not down the line", hipsAcrossM);
  }

  // The far leg is the one the detector saw worse at address.
  const seen = (side: LegSide) => {
    let total = 0;
    let count = 0;
    for (const joint of LEGS[side]) {
      for (let index = from; index <= to; index += 1) {
        total += tracks[joint].samples[index]?.visibility ?? 0;
        count += 1;
      }
    }
    return count === 0 ? 0 : total / count;
  };
  const farSide: LegSide = seen("left") <= seen("right") ? "left" : "right";
  const nearSide: LegSide = farSide === "left" ? "right" : "left";

  const centre = depth(hipMid);
  const maxShiftM = heightM * settings.maxShiftFraction;
  const shiftM: Partial<Record<ClarityJoint, number>> = {};

  const applyOffset = (farJoint: ClarityJoint, offset: number) => {
    shiftM[farJoint] = offset;
    const samples = tracks[farJoint].samples;
    for (let index = 0; index < frameCount; index += 1) {
      const sample = samples[index];
      if (!sample) continue;
      const lens = cameras[index] ?? camera;
      const sight = normalise(sub(sample.position, lens));
      // How much depth one metre along this ray buys. Down the line, nearly all.
      const gain = dot(sight, u);
      if (gain < 0.5) continue;
      samples[index] = { ...sample, position: add(sample.position, scale(sight, offset / gain)) };
    }
  };

  // Knee and ankle are mirrored; the foot rides on the ankle.
  LEGS[farSide].slice(0, 2).forEach((farJoint, slot) => {
    const nearJoint = LEGS[nearSide][slot];
    const depthsOf = (joint: ClarityJoint) => {
      const values: number[] = [];
      for (let index = from; index <= to; index += 1) {
        const sample = tracks[joint].samples[index];
        if (sample) values.push(depth(sample.position));
      }
      return values;
    };
    const nearDepths = depthsOf(nearJoint);
    const farDepths = depthsOf(farJoint);
    if (nearDepths.length === 0 || farDepths.length === 0) return;

    // Stacked: the far joint as deep behind the hips as the near one is in front.
    const neutral = 2 * centre - medianOf(nearDepths);
    const offset = neutral - medianOf(farDepths);
    if (Math.abs(offset) > maxShiftM) return;
    applyOffset(farJoint, offset);
    if (slot === 1) {
      applyOffset(LEGS[farSide][2], offset);
      applyOffset(LEGS[farSide][3], offset);
    }
  });

  const applied = Object.keys(shiftM).length > 0;
  return {
    applied,
    farSide: applied ? farSide : null,
    shiftM,
    hipsAcrossM,
    skipped: applied ? null : "the far leg was not seen at address, or sat past any neutral stance",
  };
};
