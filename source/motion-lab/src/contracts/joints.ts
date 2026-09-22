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
  /**
   * The one marker no detector reports.
   *
   * The shoulder girdle needs a third point to be a body at all: the neck is
   * defined as the shoulder midpoint, so shoulders and neck are three points
   * on one line, and a line has no orientation about itself. The sternum is
   * off that line, which makes the girdle a triangle, and it is the point the
   * shoulders actually ride on -- the two struts out to the acromia hold
   * their length while their angle opens and closes, which is what
   * protraction and retraction do.
   *
   * It is placed by `motion/reconstruct/shoulderGirdle`, from the golfer's
   * own measured shoulder width, and its provenance is always "derived".
   * Nothing in `observe/` emits it, which is why OBSERVABLE_JOINTS exists.
   */
  "sternum",
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
 * The joints a detector can actually produce.
 *
 * The difference matters wherever the question is "how much of this frame was
 * seen?". Dividing by every Clarity joint would score a perfect frame at
 * 20/21, because the sternum is derived by construction and can never be
 * observed -- and then every frame in every clip would report as partly
 * reconstructed. The denominator has to be what was available to see.
 */
export const DERIVED_JOINTS: readonly ClarityJoint[] = ["sternum"];

export const OBSERVABLE_JOINTS: readonly ClarityJoint[] = CLARITY_JOINTS.filter(
  (joint) => !DERIVED_JOINTS.includes(joint)
);

/**
 * A structure's joints, minus the ones that are always built.
 *
 * Structure confidence answers "how well was this structure SEEN?", and a
 * marker that is derived on every frame of every clip cannot help answer it.
 * Left in, the sternum would hold the thorax's score at a constant fraction
 * of the truth whatever the detector managed, which reads as a permanently
 * mediocre thorax rather than as what it is -- one joint that was never up
 * for observation.
 */
export const observedJointsOf = (structure: ClarityStructure): readonly ClarityJoint[] =>
  JOINTS_BY_STRUCTURE[structure].filter((joint) => !DERIVED_JOINTS.includes(joint));

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

  /*
   * The girdle's struts, from the sternum out to each shoulder.
   *
   * Rigid in the strongest sense in the skeleton: this is the link whose
   * length does not change while the shoulder rides forward and back on it.
   * The constraint solver never enforces them, and that is correct rather
   * than an oversight -- their length is not measured from two observed ends,
   * because one end is never observed, so the body model has no figure for
   * them and skips them. The girdle stage places both ends together and
   * satisfies them by construction; a solver re-deriving that would only be
   * able to make it worse.
   */
  { from: "sternum", to: "leftShoulder", structure: "thorax", rigid: true },
  { from: "sternum", to: "rightShoulder", structure: "thorax", rigid: true },

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
  thorax: ["neck", "sternum", "leftShoulder", "rightShoulder"],
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
