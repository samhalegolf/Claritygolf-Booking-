/**
 * Synthetic scenarios.
 *
 * Each one exists to make a specific honesty layer visible while the true
 * answer is still known. Once real video is involved that is impossible --
 * there is no ground truth to compare against -- so the time to prove that a
 * dropout LOOKS like a dropout is now.
 */

import type { SyntheticDetectorOptions } from "../observe/syntheticDetector";
import {
  generateSyntheticSwing,
  type SyntheticSwing,
  type SyntheticSwingOptions,
} from "../synthetic/syntheticSwing";

/**
 * Where the synthetic camera stands, in degrees round from face-on.
 *
 * Not zero, deliberately. Square to the camera the club's DEPTH is
 * under-determined -- both candidate depths leave the wrist angle identical --
 * so a face-on demo would show the club model at its weakest without
 * explaining why. Sixty-five degrees is a realistic place to film from and is
 * where the wrist cue has something to say. The club model's own tests cover
 * the face-on case explicitly.
 */
const DEMO_CAMERA_YAW_DEG = 65;

export interface Scenario {
  readonly key: string;
  readonly label: string;
  /** What this scenario is for. Shown under the picker. */
  readonly purpose: string;
  readonly options: SyntheticSwingOptions;
  /**
   * What the DETECTOR fails to see, for the pipeline modes.
   *
   * Kept apart from `options` on purpose. `options` degrades the body's own
   * provenance story, which is what the ground-truth view demonstrates. This
   * degrades what a detector could observe of a perfectly clean body -- which
   * is the only way to grade a reconstruction, because the truth has to stay
   * intact to compare against.
   */
  readonly detector?: SyntheticDetectorOptions;
  /**
   * A second clip of the golfer standing still, filmed through the same
   * camera, to calibrate the pitch from.
   *
   * `spineTiltDeg` is how well they followed "stand up straight" -- zero is a
   * cooperative golfer, fifteen is someone who crouched and whose shot should
   * be refused.
   */
  readonly standingShot?: { readonly spineTiltDeg: number };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    key: "clean",
    label: "Clean",
    purpose:
      "Everything observed, nothing reconstructed. The baseline: if this does not look right, the problem is the renderer, not the data.",
    options: { source: "synthetic:clean" },
    detector: { cameraYawDeg: DEMO_CAMERA_YAW_DEG },
  },
  {
    key: "tilted-camera",
    label: "Tilted camera",
    purpose:
      "A tripod pitched eight degrees down, filmed face-on. The stance line cannot see this tilt -- it rotates about that same line -- so the body looks fine while the mass reads past the toes, where a golfer would be falling over. The heel-toe readout says how far the world was pitched to put them back on their feet. Face-on deliberately: it is where a pitch is purely fore-aft, and also where the club's depth is weakest, so expect a poor club and a corrected body.",
    options: { source: "synthetic:tilted-camera" },
    // Yaw zero, not the demo angle. At an oblique yaw a camera pitch is mostly
    // a ROLL as the golfer sees it, and the stance line already removes that --
    // only the component along the stance line is what this scenario is about.
    detector: { cameraYawDeg: 0, cameraPitchDeg: 8 },
  },
  {
    key: "tilted-camera-calibrated",
    label: "Tilted camera + standing shot",
    purpose:
      "The same eight-degree tilt, plus two seconds of the golfer standing still from the same camera. The swing alone can only prove the camera was tilted at LEAST so far; a standing body is nearly a plumb line, so its fore-aft slope is nearly the camera's. Watch the applied pitch go from a partial correction to the whole of it, and the error against the known body fall with it.",
    options: { source: "synthetic:tilted-camera-calibrated" },
    detector: { cameraYawDeg: 0, cameraPitchDeg: 8 },
    standingShot: { spineTiltDeg: 0 },
  },
  {
    key: "tilted-camera-crouched",
    label: "Tilted camera + a bad standing shot",
    purpose:
      "The same again, but the golfer crouched instead of standing. The shot is refused rather than believed -- the readout says by how far they missed a plumb line -- and the world falls back to what the swing can prove on its own.",
    options: { source: "synthetic:tilted-camera-crouched" },
    detector: { cameraYawDeg: 0, cameraPitchDeg: 8 },
    standingShot: { spineTiltDeg: 15 },
  },
  {
    key: "pelvis-dropout",
    label: "Pelvis dropout",
    purpose:
      "Both hips vanish for 20 frames through the top of the backswing. Proves reconstructed provenance reaches the skeleton colouring, the ribbon and the score.",
    options: {
      source: "synthetic:pelvis-dropout",
      degradation: {
        dropouts: [
          { joint: "leftHip", startFrame: 62, length: 20 },
          { joint: "rightHip", startFrame: 62, length: 20 },
        ],
      },
    },
    detector: {
      cameraYawDeg: DEMO_CAMERA_YAW_DEG,
      dropouts: [
        { joint: "leftHip", startFrame: 62, length: 20 },
        { joint: "rightHip", startFrame: 62, length: 20 },
      ],
    },
  },
  {
    key: "hand-jump",
    label: "Hand jump",
    purpose:
      "A single-frame 25cm jump on the trail wrist during the downswing. The kind of detection a constraint solver has to reject.",
    options: {
      source: "synthetic:hand-jump",
      degradation: { jumps: [{ joint: "rightWrist", frame: 88, offsetM: 0.25 }] },
    },
    // The detector sees a clean body but loses the wrist briefly and finds it
    // again somewhere wrong -- which is what a jump actually looks like.
    detector: {
      cameraYawDeg: DEMO_CAMERA_YAW_DEG,
      dropouts: [{ joint: "rightWrist", startFrame: 88, length: 1 }],
    },
  },
  {
    key: "club-lost",
    label: "Club lost",
    purpose:
      "Clubhead evidence disappears at the top and never returns. CBP confidence decays; the body score does not move. That separation is the point.",
    options: { source: "synthetic:club-lost", degradation: { clubLostFromFrame: 74 } },
    detector: { cameraYawDeg: DEMO_CAMERA_YAW_DEG },
  },
  {
    key: "noisy",
    label: "Noisy detector",
    purpose:
      "15mm of Gaussian noise on every joint, every frame. What a real detector's jitter does to bone lengths before anything smooths it.",
    options: { source: "synthetic:noisy", degradation: { noiseM: 0.015 } },
    detector: { cameraYawDeg: DEMO_CAMERA_YAW_DEG },
  },
  {
    key: "depth-guessed",
    label: "Depth guessed, down the line",
    purpose:
      "20mm of noise on the detector's DEPTH only, filmed down the line -- the picture is exact, the lift into 3D is not, which is how a real detector fails. Click a joint: the card says how much worse depth measured than the picture, and bone fixes move joints along the line of sight first. The far hip, knee and ankle read as hidden behind the near leg.",
    options: { source: "synthetic:depth-guessed" },
    detector: { cameraYawDeg: -90, depthNoiseM: 0.02 },
  },
  {
    key: "messy",
    label: "Everything at once",
    purpose:
      "Noise, two dropouts, two jumps and a lost club. Nothing in the pipeline should collapse; the score should simply be low and say why.",
    options: {
      source: "synthetic:messy",
      degradation: {
        noiseM: 0.012,
        dropouts: [
          { joint: "leftAnkle", startFrame: 30, length: 14 },
          { joint: "rightElbow", startFrame: 95, length: 22 },
        ],
        jumps: [
          { joint: "head", frame: 50, offsetM: 0.18 },
          { joint: "leftKnee", frame: 110, offsetM: 0.22 },
        ],
        clubLostFromFrame: 100,
      },
    },
    detector: {
      cameraYawDeg: DEMO_CAMERA_YAW_DEG,
      dropouts: [
        { joint: "leftAnkle", startFrame: 30, length: 14 },
        { joint: "rightElbow", startFrame: 95, length: 22 },
      ],
      blindFrames: [50, 51, 52],
    },
  },
];

export const buildScenario = (scenario: Scenario): SyntheticSwing =>
  generateSyntheticSwing(scenario.options);

/**
 * The same scenario, seen three ways.
 *
 * Putting them behind one switch is the point. "Is the reconstruction any
 * good?" is not answerable by looking at a reconstruction -- it needs the
 * truth it is approximating and the do-nothing baseline, on the same data, a
 * click apart.
 */
export type PipelineMode = "truth" | "passthrough" | "motion-layer";

export const PIPELINE_MODES: readonly {
  key: PipelineMode;
  label: string;
  hint: string;
}[] = [
  {
    key: "truth",
    label: "Ground truth",
    hint: "The body as generated. No detector involved — what the reconstruction is trying to recover.",
  },
  {
    key: "passthrough",
    label: "Baseline",
    hint: "Through a detector, with no reconstruction. A joint the detector missed stays missing.",
  },
  {
    key: "motion-layer",
    label: "Motion Layer",
    hint: "Through a detector and the full Clarity Motion Layer.",
  },
];
