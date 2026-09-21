/**
 * The Clarity skeleton: named joints, the bones between them, and the
 * structures those bones belong to.
 *
 * These names are the vocabulary of the ClarityFrame boundary. Nothing
 * downstream of the Motion Layer ever refers to a detector's landmark index.
 * `observe/` owns the mapping from indices to these names, and it is the only
 * place that mapping exists.
 */

/**
 * Point markers on the reconstructed body.
 *
 * Deliberately NOT a copy of MediaPipe's 33. Face landmarks are dropped (the
 * reconstruction has no use for eye corners), and heel/toe are kept because
 * the support model needs a foot polygon rather than a single ankle point.
 */
export const CLARITY_JOINTS = [
  "head",
  "neck",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHand",
  "rightHand",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftHeel",
  "rightHeel",
  "leftToe",
  "rightToe",
] as const;

export type ClarityJoint = (typeof CLARITY_JOINTS)[number];

export const isClarityJoint = (value: string): value is ClarityJoint =>
  (CLARITY_JOINTS as readonly string[]).includes(value);

/**
 * Structures that carry their own confidence.
 *
 * The plan is explicit that a poor club track must not invalidate an
 * otherwise strong body reconstruction, so confidence is reported per
 * structure and not only as one number.
 */
export const CLARITY_STRUCTURES = [
  "thorax",
  "pelvis",
  "head",
  "leftArm",
  "rightArm",
  "leftLeg",
  "rightLeg",
  "hands",
  "feet",
  "club",
] as const;

export type ClarityStructure = (typeof CLARITY_STRUCTURES)[number];

/**
 * A rigid link between two joints.
 *
 * `structure` is what the link's confidence rolls up into. `rigid` marks the
 * links whose length is treated as constant for a given golfer -- these are
 * the ones the constraint solver may enforce. Links across the pelvis and
 * shoulder girdle are rigid; links that span a compressible or multi-axis
 * region are not.
 */
export interface Bone {
  readonly from: ClarityJoint;
  readonly to: ClarityJoint;
  readonly structure: ClarityStructure;
  readonly rigid: boolean;
}

export const CLARITY_BONES: readonly Bone[] = [
  // Axial
  { from: "head", to: "neck", structure: "head", rigid: true },
  { from: "neck", to: "leftShoulder", structure: "thorax", rigid: true },
  { from: "neck", to: "rightShoulder", structure: "thorax", rigid: true },
  { from: "leftShoulder", to: "rightShoulder", structure: "thorax", rigid: true },

  // The spine link is NOT rigid: thorax-to-pelvis separation genuinely
  // changes with flexion and extension, and pinning it would manufacture
  // stability the observations do not support.
  { from: "leftShoulder", to: "leftHip", structure: "thorax", rigid: false },
  { from: "rightShoulder", to: "rightHip", structure: "thorax", rigid: false },

  // Pelvis
  { from: "leftHip", to: "rightHip", structure: "pelvis", rigid: true },

  // Arms
  { from: "leftShoulder", to: "leftElbow", structure: "leftArm", rigid: true },
  { from: "leftElbow", to: "leftWrist", structure: "leftArm", rigid: true },
  { from: "leftWrist", to: "leftHand", structure: "hands", rigid: true },
  { from: "rightShoulder", to: "rightElbow", structure: "rightArm", rigid: true },
  { from: "rightElbow", to: "rightWrist", structure: "rightArm", rigid: true },
  { from: "rightWrist", to: "rightHand", structure: "hands", rigid: true },

  // Legs
  { from: "leftHip", to: "leftKnee", structure: "leftLeg", rigid: true },
  { from: "leftKnee", to: "leftAnkle", structure: "leftLeg", rigid: true },
  { from: "rightHip", to: "rightKnee", structure: "rightLeg", rigid: true },
  { from: "rightKnee", to: "rightAnkle", structure: "rightLeg", rigid: true },

  // Feet
  { from: "leftAnkle", to: "leftHeel", structure: "feet", rigid: true },
  { from: "leftHeel", to: "leftToe", structure: "feet", rigid: true },
  { from: "leftAnkle", to: "leftToe", structure: "feet", rigid: true },
  { from: "rightAnkle", to: "rightHeel", structure: "feet", rigid: true },
  { from: "rightHeel", to: "rightToe", structure: "feet", rigid: true },
  { from: "rightAnkle", to: "rightToe", structure: "feet", rigid: true },
];

/** The rigid subset, precomputed -- the constraint solver walks this every frame. */
export const RIGID_BONES: readonly Bone[] = CLARITY_BONES.filter((bone) => bone.rigid);

/** Which joints the given structure is built from. Used to roll confidence up. */
export const JOINTS_BY_STRUCTURE: Readonly<Record<ClarityStructure, readonly ClarityJoint[]>> = {
  thorax: ["neck", "leftShoulder", "rightShoulder"],
  pelvis: ["leftHip", "rightHip"],
  head: ["head", "neck"],
  leftArm: ["leftShoulder", "leftElbow", "leftWrist"],
  rightArm: ["rightShoulder", "rightElbow", "rightWrist"],
  leftLeg: ["leftHip", "leftKnee", "leftAnkle"],
  rightLeg: ["rightHip", "rightKnee", "rightAnkle"],
  hands: ["leftWrist", "leftHand", "rightWrist", "rightHand"],
  feet: ["leftAnkle", "leftHeel", "leftToe", "rightAnkle", "rightHeel", "rightToe"],
  // The club is not built from body joints; its confidence comes from club
  // evidence alone. An empty list here is meaningful, not an omission.
  club: [],
};

/** A bone key, stable across runs, for keying per-bone state. */
export const boneKey = (bone: Bone): string => `${bone.from}~${bone.to}`;
