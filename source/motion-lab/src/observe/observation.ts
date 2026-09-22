/**
 * What a detector produces. Deliberately ugly.
 *
 * This is the evidence layer. It keeps dropouts, jumps, low visibility and
 * reacquisition visible rather than papering over them -- the raw debug
 * overlay draws straight from these types, and its job is to stay honest
 * about what the detector could actually see.
 *
 * NOTHING IN `space3d/` MAY IMPORT THIS FILE. The 3D Space consumes
 * ClarityFrame and only ClarityFrame. `contracts/boundary.test.ts` enforces
 * that mechanically.
 *
 * Coordinate conventions here are the DETECTOR's, not Clarity's:
 *   - `image`  normalised 0..1, origin top-left, Y DOWN
 *   - `world`  metres, hip-centred, Y DOWN, arbitrary yaw
 * The conversion into Clarity world space (Y-up, ground origin) happens in
 * exactly one place: `observe/toObservationFrame.ts`.
 */

import type { ClarityJoint } from "../contracts/joints";
import type { TimestampMs, Unit, WorldFrameAnchor } from "../contracts/units";

/** One landmark as the detector reported it. No cleaning, no filling. */
export interface RawLandmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * The detector's ONE belief about this point, and it is worth being precise
   * about what it means, because the name invites a stronger reading than it
   * can support.
   *
   * It answers "is this body part in the picture". It does NOT answer "did I
   * put it in the right place". A landmark snapped onto the wrong part of the
   * body is still in the picture, so a confidently mislocated point reports
   * the same 1.0 as a correct one. Nothing downstream may treat this as an
   * accuracy score; accuracy is what the Motion Layer measures against the
   * body, from the bones.
   *
   * MediaPipe's underlying model also has a `presence` output, but the tasks
   * API does not surface it, so there is no second opinion here to pair this
   * one with.
   */
  readonly visibility: Unit;
}

/**
 * A clubhead candidate in image space.
 *
 * Kept separate from body landmarks because it comes from a different
 * evidence path and, per the plan, must never be treated as the authoritative
 * balance point. It is evidence for a club model, not the club model.
 */
export interface ClubObservation {
  /** Normalised image coordinates, Y DOWN, of the candidate region centre. */
  readonly imageX: number;
  readonly imageY: number;
  /** Radius of the candidate region, normalised. Wide means uncertain. */
  readonly imageRadius: number;
  readonly confidence: Unit;
}

/**
 * One frame of detector output.
 *
 * `detected: false` with both landmark arrays null is a real, meaningful
 * state -- the detector saw nothing. It is NOT the same as a request that
 * failed, which never reaches this type at all.
 */
export interface ObservationFrame {
  readonly index: number;
  readonly timestampMs: TimestampMs;
  readonly detected: boolean;
  /** Normalised image landmarks, detector-indexed. Null when not detected. */
  readonly image: readonly RawLandmark[] | null;
  /** Metric world landmarks, detector-indexed, hip-centred. May be null. */
  readonly world: readonly RawLandmark[] | null;
  /** Club evidence, when a club tracker contributed. */
  readonly club: ClubObservation | null;
}

/**
 * Detector output with landmarks renamed into Clarity's vocabulary, but
 * otherwise untouched.
 *
 * RELABELLED, NOT RECONSTRUCTED. Gaps are still gaps, jumps are still jumps,
 * and a joint the detector never saw is ABSENT from the record rather than
 * filled in. Anything cleverer belongs to the Motion Layer, where it can be
 * recorded in provenance and paid for in confidence. Doing it here would hide
 * it.
 *
 * THE TWO SPACES
 *
 * Observations arrive in the detector's frame and have to reach Clarity's.
 * Those are different spaces, and conflating them is the classic way to spend
 * an afternoon debugging an upside-down or mirrored body. So they are
 * different TYPES, and the compiler keeps them apart:
 *
 *   CameraObservationFrame   Y-up, metres, origin at the hip midpoint, yaw
 *                            still whatever the camera happened to be. One
 *                            step from the detector.
 *
 *   WorldObservationFrame    Clarity world space: Y-up, metres, origin on the
 *                            ground under the support centre, +X along the
 *                            measured stance line. Anchored.
 *
 * The Motion Layer accepts only the second. Handing it the first is a
 * compile error rather than a body lying on its side.
 */
interface NamedObservationFrameBase {
  readonly index: number;
  readonly timestampMs: TimestampMs;
  readonly detected: boolean;
  /**
   * Partial by design. An absent key means "not observed", which is the
   * distinction the whole Motion Layer is built to respect.
   */
  readonly joints: Readonly<Partial<Record<ClarityJoint, ObservedJoint>>>;
  readonly club: ClubObservation | null;
}

/** One step from the detector: Y-up metres, hip-centred, camera yaw. */
export interface CameraObservationFrame extends NamedObservationFrameBase {
  readonly space: "camera";
}

/** Anchored into Clarity world space. The Motion Layer's input. */
export interface WorldObservationFrame extends NamedObservationFrameBase {
  readonly space: "world";
}

export type NamedObservationFrame = CameraObservationFrame | WorldObservationFrame;

export interface ObservedJoint {
  /** Metres, Y-UP. Which origin and yaw depends on the frame's `space`. */
  readonly position: readonly [number, number, number];
  /** Normalised image position, Y DOWN, for the video overlay. */
  readonly image: readonly [number, number];
  readonly visibility: Unit;
  /**
   * How many landmarks were combined for this joint. 1 for a direct mapping,
   * more for a midpoint. A derived joint is only as good as its worst input,
   * and `visibility` already reflects that -- this says it was derived at all.
   */
  readonly sourceCount: number;
}

interface ObservationSequenceBase {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** Which detector and model produced this, for the debug panel. */
  readonly detector: string;
}

/** A whole take, straight off the detector. */
export interface CameraObservationSequence extends ObservationSequenceBase {
  readonly space: "camera";
  readonly frames: readonly CameraObservationFrame[];
}

/** A whole take, anchored. The Motion Layer's input. */
export interface WorldObservationSequence extends ObservationSequenceBase {
  readonly space: "world";
  readonly frames: readonly WorldObservationFrame[];
  readonly anchor: WorldFrameAnchor;
}

export type ObservationSequence = CameraObservationSequence | WorldObservationSequence;
