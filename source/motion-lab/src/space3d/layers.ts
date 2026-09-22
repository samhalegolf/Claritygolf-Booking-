/**
 * What the 3D Space can show.
 *
 * The first user is the developer, so the default is deliberately more
 * information than a finished product would carry. The point of this build is
 * to find out which signals are genuinely useful before anything gets
 * simplified away.
 */

export interface SceneLayers {
  readonly skeleton: boolean;
  readonly joints: boolean;
  /** Colour joints by provenance rather than a single bone colour. */
  readonly provenanceColouring: boolean;
  readonly thorax: boolean;
  readonly pelvis: boolean;
  readonly club: boolean;
  readonly cbp: boolean;
  readonly cbpTrail: boolean;
  readonly massCloud: boolean;
  readonly upperMass: boolean;
  readonly support: boolean;
  readonly ground: boolean;
  readonly ball: boolean;
}

export const DEFAULT_LAYERS: SceneLayers = {
  skeleton: true,
  joints: true,
  provenanceColouring: true,
  thorax: true,
  pelvis: true,
  club: true,
  cbp: true,
  cbpTrail: true,
  massCloud: false,
  upperMass: true,
  support: true,
  ground: true,
  ball: true,
};

export interface LayerDescriptor {
  readonly key: keyof SceneLayers;
  readonly label: string;
  readonly group: "Body" | "Club" | "Mass" | "Scene";
  /** Why a developer would turn this on. Shown as a tooltip. */
  readonly hint: string;
}

export const LAYER_DESCRIPTORS: readonly LayerDescriptor[] = [
  { key: "skeleton", label: "Skeleton", group: "Body", hint: "Bones between the joints. Both views: reconstructed bones in the 3D Space, MediaPipe's own connections on the video." },
  { key: "joints", label: "Joint markers", group: "Body", hint: "Both views: one marker per Clarity joint in the 3D Space, MediaPipe's 33 landmarks on the video." },
  {
    key: "provenanceColouring",
    label: "Colour by provenance",
    group: "Body",
    hint: "Green observed, blue anchored, amber constrained, teal derived, orange reconstructed, purple extrapolated, dark red missing.",
  },
  { key: "thorax", label: "Thorax body", group: "Body", hint: "The persistent rib-cage structure and its orientation." },
  { key: "pelvis", label: "Pelvis body", group: "Body", hint: "The persistent pelvis structure and its orientation." },
  { key: "club", label: "Reconstructed club", group: "Club", hint: "Beta. Kinematic only — if it stretches or detaches, the tracking underneath needs a look." },
  { key: "cbp", label: "Club balance point", group: "Club", hint: "The derived CBP, not a detected clubhead centre." },
  { key: "cbpTrail", label: "CBP trail", group: "Club", hint: "The balance point's path through 3D space." },
  { key: "massCloud", label: "Mass cloud", group: "Mass", hint: "The weighted parcels the mass centres are computed from." },
  { key: "upperMass", label: "Upper mass map", group: "Mass", hint: "Mass from the hip joints up, and its projection to the ground." },
  { key: "support", label: "Estimated support", group: "Mass", hint: "Estimated foot load. An estimate from video, not force-plate data." },
  { key: "ground", label: "Ground", group: "Scene", hint: "Ground plane and grid." },
  { key: "ball", label: "Ball", group: "Scene", hint: "Where the ball was placed, for reference." },
];
