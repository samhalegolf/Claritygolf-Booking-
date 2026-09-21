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
import type { TimestampMs, Unit } from "../contracts/units";

/** One landmark as the detector reported it. No cleaning, no filling. */
export interface RawLandmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Detector's belief the point is in frame and locatable. */
  readonly visibility: Unit;
  /** Detector's belief the body part exists in the image at all. */
  readonly presence: Unit;
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
 * Detector output with landmarks renamed into Clarity's vocabulary and
 * rotated into Clarity world space, but otherwise untouched.
 *
 * This is the last type before the Motion Layer. It has been RELABELLED, not
 * reconstructed: gaps are still gaps, jumps are still jumps, and a joint the
 * detector never saw is absent from the record rather than filled in.
 */
export interface NamedObservationFrame {
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

export interface ObservedJoint {
  /** Clarity world space: metres, Y-UP, ground-plane origin. */
  readonly position: readonly [number, number, number];
  /** Normalised image position, Y DOWN, for the video overlay. */
  readonly image: readonly [number, number];
  readonly visibility: Unit;
  readonly presence: Unit;
}

/** A whole take, as observed. The Motion Layer's input. */
export interface ObservationSequence {
  readonly frames: readonly NamedObservationFrame[];
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** Which detector and model produced this, for the debug panel. */
  readonly detector: string;
}
