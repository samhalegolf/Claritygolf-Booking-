/**
 * The 3D Space's visual vocabulary.
 *
 * One rule runs through all of it: COLOUR MEANS PROVENANCE. A viewer glancing
 * at the scene should be able to tell what was seen from what was worked out
 * without opening a panel. That is the whole reason the renderer is handed
 * provenance on every joint instead of just positions.
 *
 * Hues are chosen to stay distinguishable for the common colour-vision
 * deficiencies -- the observed/reconstructed distinction is carried by
 * lightness as well as hue, so it survives being seen in greyscale.
 */

import type { ProvenanceSource } from "../contracts";

export const PALETTE = {
  background: 0x0b0f14,
  ground: 0x1b2430,
  gridMajor: 0x2c3a4a,
  gridMinor: 0x1e2833,

  bone: 0x8fa6bd,
  thorax: 0x4fc3f7,
  pelvis: 0xffb74d,

  club: 0xd7dde5,
  clubhead: 0xffffff,
  cbp: 0x69f0ae,
  cbpTrailPast: 0x69f0ae,
  cbpTrailFuture: 0x2b4a3d,

  upperMass: 0xef5da8,
  upperMassGround: 0xef5da8,
  supportCentre: 0xffd54f,
  supportPolygon: 0xffd54f,
  massCloudUpper: 0xef5da8,
  massCloudLower: 0x7986cb,

  ball: 0xffffff,
  targetLine: 0x37474f,
} as const;

/**
 * Joint colour by provenance.
 *
 * "missing" is deliberately a dark, desaturated red rather than simply being
 * hidden: an absent joint is a FACT about the reconstruction, and hiding it
 * would make a hole in the body look like a rendering glitch.
 */
export const PROVENANCE_COLOURS: Readonly<Record<ProvenanceSource, number>> = {
  observed: 0x7cf6a0,
  anchored: 0x4fc3f7,
  constrained: 0xffd54f,
  reconstructed: 0xff8a65,
  extrapolated: 0xba68c8,
  missing: 0x5d2b2b,
};

export const PROVENANCE_LABELS: Readonly<Record<ProvenanceSource, string>> = {
  observed: "Observed",
  anchored: "Anchored",
  constrained: "Constrained",
  reconstructed: "Reconstructed",
  extrapolated: "Extrapolated",
  missing: "Missing",
};

/** Joint marker radius in metres, before per-joint scaling. */
export const JOINT_RADIUS_M = 0.022;
export const CBP_RADIUS_M = 0.035;
