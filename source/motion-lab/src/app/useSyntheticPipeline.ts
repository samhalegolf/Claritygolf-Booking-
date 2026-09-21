/**
 * The same synthetic swing, seen through three different amounts of
 * machinery.
 *
 * Ground truth, a detector with no reconstruction, and a detector with the
 * full Motion Layer -- all from one body, so the comparison is fair. This is
 * the only place in the lab where "is the reconstruction actually better?"
 * can be answered by looking, because it is the only place the true answer
 * exists.
 */

import { useMemo } from "react";

import type { ClaritySequence, Vec3 } from "../contracts";
import { passthroughSequence } from "../motion/passthrough";
import { reconstruct, type ReconstructOptions } from "../motion/reconstruct/reconstruct";
import { anchorSequence } from "../observe/anchor";
import type { CameraObservationSequence } from "../observe/observation";
import { detectFromClarityFrames } from "../observe/syntheticDetector";
import { toCameraFrame } from "../observe/toCameraFrame";
import { generateSyntheticSwing } from "../synthetic/syntheticSwing";
import { buildScenario, type PipelineMode, type Scenario } from "./scenarios";

export interface SyntheticPipeline {
  readonly sequence: ClaritySequence;
  readonly ballPosition?: Vec3;
  /** Mean joint error against ground truth, metres. Null for truth itself. */
  readonly errorVsTruthM: number | null;
  /** What each reconstruction stage did. Null unless the Motion Layer ran. */
  readonly stageCounts: Readonly<Record<string, number>> | null;
}

export const useSyntheticPipeline = (
  scenario: Scenario,
  mode: PipelineMode,
  stages: ReconstructOptions["stages"]
): SyntheticPipeline =>
  useMemo(() => {
    // Ground truth shows the scenario's own body, degradation and all: that
    // view is about provenance, not about reconstruction.
    if (mode === "truth") {
      const swing = buildScenario(scenario);
      return {
        sequence: swing,
        ballPosition: swing.ballPosition,
        errorVsTruthM: null,
        stageCounts: null,
      };
    }

    /*
     * The pipeline modes run a CLEAN body through a faulty detector.
     *
     * The body has to stay clean or there is nothing to grade against: a
     * reconstruction can only be scored if the truth it is approximating is
     * still available. The faults therefore live in the detector, which is
     * also where they live in reality.
     */
    const truth = generateSyntheticSwing({ source: "synthetic:truth" });
    const raw = detectFromClarityFrames(truth.frames, scenario.detector ?? {});
    const camera: CameraObservationSequence = {
      space: "camera",
      frames: raw.map((frame) => toCameraFrame(frame)),
      fps: truth.fps,
      width: 1920,
      height: 1080,
      durationMs: (truth.frames.length / truth.fps) * 1000,
      detector: `synthetic:${scenario.key}`,
    };
    const observations = anchorSequence(camera);

    const report = mode === "motion-layer" ? reconstruct(observations, { stages }) : null;
    const sequence = report ? report.sequence : passthroughSequence(observations);

    let total = 0;
    let count = 0;
    for (let index = 0; index < sequence.frames.length; index += 1) {
      const actual = sequence.frames[index].body.joints;
      const expected = truth.frames[index].body.joints;
      for (const joint of Object.keys(expected) as (keyof typeof expected)[]) {
        const a = actual[joint];
        const b = expected[joint];
        total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        count += 1;
      }
    }

    return {
      sequence,
      ballPosition: truth.ballPosition,
      errorVsTruthM: count === 0 ? null : total / count,
      stageCounts: report?.stageCounts ?? null,
    };
  }, [scenario, mode, stages]);
