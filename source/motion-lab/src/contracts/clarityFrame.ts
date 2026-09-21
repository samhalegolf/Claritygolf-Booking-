/**
 * THE CLARITYFRAME BOUNDARY
 *
 * This file is the contract between the Clarity Motion Layer and the 3D
 * Space. It is the architectural rule of the whole build, written as types:
 *
 *     GOOGLE OBSERVES.  CLARITY RECONSTRUCTS.  THE 3D SPACE RENDERS CLARITY.
 *
 * The renderer consumes this and nothing else. It does not know what a
 * MediaPipe landmark index is, it cannot reach one, and a test in
 * `contracts/boundary.test.ts` fails the build if `space3d/` ever imports
 * from `observe/`.
 *
 * Everything here is readonly. A ClarityFrame is a finished statement about
 * one moment: the renderer reads it, it does not negotiate with it.
 */

import type { ClarityJoint, ClarityStructure } from "./joints";
import type { Metres, Quat, TimestampMs, Unit, Vec3, WorldFrameAnchor } from "./units";

/* ------------------------------------------------------------------ *
 * Provenance -- how much of this was seen, and how much was worked out
 * ------------------------------------------------------------------ */

/**
 * Where a value came from. This is the honesty channel: the debug layers
 * colour by it, and the confidence maths weighs by it.
 */
export type ProvenanceSource =
  /** A detector reported this joint at this frame and the layer accepted it. */
  | "observed"
  /** Seen, but moved by the constraint solver to keep the body coherent. */
  | "constrained"
  /** Not seen. Rebuilt from observations on BOTH sides of a gap. */
  | "reconstructed"
  /** Not seen, and no later observation to close the gap. Forward guess only. */
  | "extrapolated"
  /** Not seen and not recoverable. The renderer should show absence, not a point. */
  | "missing";

export interface JointProvenance {
  readonly source: ProvenanceSource;
  /**
   * How far the layer moved this joint from the raw observation, in metres.
   * Zero for an untouched observation; meaningless (0) when nothing was seen.
   * Large values are the signal that the reconstruction is fighting the data.
   */
  readonly correctionM: Metres;
  /**
   * Frames since this joint was last directly observed. 0 when observed now.
   * For a reconstructed joint mid-gap this is its distance into the gap.
   */
  readonly framesSinceObserved: number;
  /** Total length of the gap this frame sits inside. 0 when observed. */
  readonly gapLength: number;
  /** The detector's own confidence in the observation, if there was one. */
  readonly rawConfidence: Unit;
}

export interface FrameProvenance {
  readonly joints: Readonly<Record<ClarityJoint, JointProvenance>>;
  /** Fraction of joints this frame that were directly observed. */
  readonly observedFraction: Unit;
  /** True when no detector output existed for this frame at all. */
  readonly wholeFrameReconstructed: boolean;
}

/* ------------------------------------------------------------------ *
 * Confidence
 * ------------------------------------------------------------------ */

/**
 * The components behind the overall score.
 *
 * Each is 0..1 where 1 means "no reconstruction was needed". These measure
 * HOW MUCH ASSUMPTION WAS REQUIRED -- explicitly not whether the movement
 * looks like a normal golf swing. A bizarre but cleanly observed motion
 * should score high.
 */
export interface ConfidenceComponents {
  /** Share of joints observed rather than invented. */
  readonly directObservation: Unit;
  /** How unbroken the track has been through recent frames. */
  readonly trackingContinuity: Unit;
  /** 1 when no implausible single-frame jumps had to be damped. */
  readonly jumpCorrection: Unit;
  /** 1 when nothing was interpolated across a gap. */
  readonly gapReconstruction: Unit;
  /** 1 when bone-length constraints did not have to move anything. */
  readonly bodyConstraintCorrection: Unit;
  /** Club evidence quality. Independent of the body score by design. */
  readonly clubPoint: Unit;
}

export interface FrameConfidence {
  /** 0..1. Render it as 0-100 for humans; store it as a unit interval. */
  readonly overall: Unit;
  readonly components: ConfidenceComponents;
  /** Per-structure, so a bad club track cannot sink a good body track. */
  readonly structures: Readonly<Record<ClarityStructure, Unit>>;
}

/* ------------------------------------------------------------------ *
 * Body
 * ------------------------------------------------------------------ */

/**
 * A persistent connected structure, not a cloud of independent points.
 *
 * Carrying an orientation is the whole point: once several observations have
 * established the pelvis, losing four of its markers must not collapse it.
 * The body continues to exist, with a pose, and returning observations
 * confirm or correct it rather than replacing it.
 */
export interface RigidStructure {
  readonly centre: Vec3;
  readonly orientation: Quat;
  /** Box half-extents in the structure's own frame, metres. For drawing. */
  readonly halfExtents: Vec3;
  /**
   * How much of this structure's pose came from observation this frame,
   * as opposed to being carried forward from the persistent model.
   */
  readonly support: Unit;
}

export interface BodyPose {
  /**
   * Every joint, always present. A joint the layer could not place has
   * provenance "missing" -- the renderer checks provenance, not null, so a
   * missing joint is a visible fact rather than a hole.
   */
  readonly joints: Readonly<Record<ClarityJoint, Vec3>>;
  readonly thorax: RigidStructure;
  readonly pelvis: RigidStructure;
}

/* ------------------------------------------------------------------ *
 * Club
 * ------------------------------------------------------------------ */

/**
 * The club estimate.
 *
 * The key derived marker is the CBP: the estimated club balance point. The
 * plan is firm that the CBP is DERIVED FROM RECONSTRUCTED CLUB GEOMETRY, not
 * detected from pixels -- clubhead orientation, lighting and silhouette all
 * shift the detected image region, so treating the apparent clubhead centre
 * as the balance point would bake that noise in.
 *
 * `grip` and `head` are the geometry the CBP was derived from, exposed so the
 * optional 3D club can draw it and so a visibly stretching or disconnected
 * club can be used as a debugging signal.
 */
export interface ClubEstimate {
  readonly cbp: Vec3;
  readonly grip: Vec3;
  readonly head: Vec3;
  /** Reconstructed shaft length, metres. Should be near-constant per swing. */
  readonly lengthM: Metres;
  /**
   * What the estimate actually rests on this frame. When direct club evidence
   * disappears, confidence falls -- the layer does not invent club movement
   * indefinitely.
   */
  readonly evidence: {
    readonly headObserved: boolean;
    readonly gripFromHands: boolean;
    readonly shaftObserved: boolean;
    readonly framesSinceHeadObserved: number;
  };
  readonly confidence: Unit;
}

/* ------------------------------------------------------------------ *
 * Mass and support
 * ------------------------------------------------------------------ */

/**
 * The mass model, as a fixed relative pot of virtual units distributed over
 * personalised body geometry. Absolute body weight is not required and is not
 * claimed. Nothing here infers body composition.
 *
 * Upper mass and support are deliberately SEPARATE concepts:
 *
 *   upperMassCentre        where the mass above the hip joints actually is
 *   upperMassGround        that mass projected straight down onto the ground.
 *                          It need not land under either foot.
 *   supportCentre          where supported weight is estimated to reach the
 *                          ground. This one MUST lie inside the foot support
 *                          polygon.
 *
 * This is an estimate from video, not force-plate data. No rotational or
 * torsional forces are modelled and no measured pressure is claimed.
 */
/**
 * One lump of the weighted mass cloud, in world space.
 *
 * Carried on the frame rather than recomputed by the renderer: working out
 * where the mass sits is a Motion Layer decision, and a renderer that derives
 * it independently is a second, divergent implementation of the mass model.
 */
export interface MassCloudPoint {
  readonly label: string;
  readonly position: Vec3;
  /** Share of the fixed virtual pot carried here. */
  readonly units: number;
  /** True when this parcel is above the hip joints, i.e. in the Upper Mass Map. */
  readonly upper: boolean;
}

export interface MassEstimate {
  readonly upperMassCentre: Vec3;
  readonly upperMassGround: Vec3;
  readonly supportCentre: Vec3;
  /**
   * Separation of upperMassGround from supportCentre along the stance line,
   * normalised by stance width. Positive toward the right foot.
   *
   * An experimental descriptive signal. No good/bad meaning is assigned to
   * any value, here or anywhere downstream.
   */
  readonly normalisedSeparation: number;
  /** Share of the virtual mass pot currently carried by each foot, 0..1. */
  readonly footShare: { readonly left: Unit; readonly right: Unit };
  /**
   * The ground-contact polygon the support centre was constrained into, in
   * world space and on the ground plane. Empty when no foot is in contact --
   * which is a real state during a follow-through, not an error.
   */
  readonly supportPolygon: readonly Vec3[];
  /** The full weighted cloud, for the debug view. */
  readonly cloud: readonly MassCloudPoint[];
  readonly confidence: Unit;
}

/* ------------------------------------------------------------------ *
 * Sanity of the fore-aft mass reading
 * ------------------------------------------------------------------ */

/**
 * The fore-aft mass reading for one body, and the part of it a camera angle
 * cannot have invented.
 */
export interface MassReading {
  /** Where the mass sits between the heel line (0) and the toe line (1). */
  readonly footFractionUnit: Unit;
  /**
   * The same reading with every possible camera pitch removed.
   *
   * The mass position relative to the golfer's own stacked axis -- what their
   * BEND puts there, with any whole-body lean taken out along with the camera.
   * It is not "where the mass really is"; it is the part of where the mass is
   * that a camera cannot have invented.
   */
  readonly bendFractionUnit: number;
  /** Height of the mass centre above the ankles. The lever a pitch works through. */
  readonly massHeightM: Metres;
  /** Heel to toe, metres. */
  readonly footSpanM: Metres;
}

/**
 * Whether the clip's fore-aft mass reading is physically possible, and what
 * that proves about the camera.
 *
 * WHY THIS IS ON THE SEQUENCE AND NOT THE FRAME
 *
 * A camera's pitch is one number for a whole clip. Reporting it per frame
 * would invite averaging it, or worse, correcting each frame by a different
 * amount -- which would deform the swing rather than level the world.
 *
 * WHAT IT IS NOT
 *
 * Not a correction that has been applied. Every coordinate in the sequence is
 * exactly as the anchoring left it. This says what the mass reading implies
 * about the camera; acting on it is a separate decision, deliberately not
 * taken here.
 */
export interface MassSanity {
  /** Frames the check ran over: detected, feet observed, standing on both. */
  readonly samples: number;
  /** The median reading across those frames. */
  readonly reading: MassReading;
  /** Frames whose mass fell outside the feet, which a standing golfer's cannot. */
  readonly impossibleFrames: number;
  /**
   * The camera pitches consistent with every one of those frames, degrees.
   * Unbounded ends are reported as +/- 90.
   */
  readonly pitchRangeDeg: readonly [number, number];
  /**
   * The smallest pitch inside that range, degrees -- the least the camera can
   * have been tilted given what the body did. Zero whenever a level camera is
   * still possible, which is the common and correct answer.
   */
  readonly minimumPitchDeg: number;
  /** What the reading becomes once `minimumPitchDeg` is allowed for. */
  readonly correctedFootFractionUnit: number;
  /**
   * How far the BEND moved the mass across the clip, metres.
   *
   * Pitch-free twice over: the bend is pitch-free, and a range is a set of
   * differences, which a constant pitch cancels out of anyway.
   */
  readonly bendRangeM: Metres;
  /**
   * How far the whole-body LEAN moved it, metres. Also pitch-free as a range,
   * though its absolute value is not.
   */
  readonly leanRangeM: Metres;
  readonly verdict: "consistent" | "corrected" | "irreconcilable" | "undetermined";
  /** Confidence in the corrected reading, after everything above. */
  readonly confidence: Unit;
}

/* ------------------------------------------------------------------ *
 * The frame
 * ------------------------------------------------------------------ */

export interface ClarityFrame {
  readonly index: number;
  readonly timestampMs: TimestampMs;
  readonly body: BodyPose;
  /** Null when no club evidence has ever been established for this sequence. */
  readonly club: ClubEstimate | null;
  /** Null when the body model is too incomplete to distribute mass over. */
  readonly mass: MassEstimate | null;
  readonly confidence: FrameConfidence;
  readonly provenance: FrameProvenance;
}

/* ------------------------------------------------------------------ *
 * The sequence
 * ------------------------------------------------------------------ */

/**
 * Personalised segment geometry, established from stable observations across
 * the whole sequence rather than assumed from a population table.
 *
 * This is what makes "a femur does not suddenly change length" enforceable:
 * the constraint needs to know how long THIS golfer's femur is.
 */
export interface BodyModel {
  /** Metres, keyed by `boneKey(bone)`. Only rigid bones appear. */
  readonly boneLengths: Readonly<Record<string, Metres>>;
  /** How well-established each length is. Low means few clean observations. */
  readonly boneConfidence: Readonly<Record<string, Unit>>;
  /** Standing height estimate, metres. Used to scale the scene, nothing more. */
  readonly estimatedHeightM: Metres;
  /** Frames that contributed to the model. */
  readonly sampleCount: number;
}

export interface SequenceConfidence {
  readonly overall: Unit;
  readonly components: ConfidenceComponents;
  /** Fraction of frames with any reconstructed joint. */
  readonly reconstructedFrameFraction: Unit;
  /** Longest run of consecutive frames with no direct observation. */
  readonly largestGapFrames: number;
}

export interface ClaritySequence {
  readonly frames: readonly ClarityFrame[];
  readonly fps: number;
  readonly bodyModel: BodyModel;
  readonly anchor: WorldFrameAnchor;
  readonly confidence: SequenceConfidence;
  /**
   * Whether the fore-aft mass reading is physically possible, and the least
   * camera pitch that would explain it if not.
   *
   * Null when no frame in the clip was standing on two observed feet, which
   * is a real state -- a clip that starts mid-swing has nothing to check
   * against -- and not the same as "the reading is fine".
   *
   * Nothing in this sequence has been corrected for it. See `MassSanity`.
   */
  readonly massSanity: MassSanity | null;
  /** Free-text provenance of the source, for the debug panel. */
  readonly source: string;
}
