import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineMarker } from "../models/Timeline";
import type { SwingPhases } from "../../../../motion-lab/src/embed/detectSwingPhases";
import { markersAreUntouched, placeMarkersAtPhases } from "../utils/motionLabMarkers";

// Runs the motion lab's phase detection over a panel's clip and moves that
// panel's timeline markers onto what it finds.
//
// It starts on its own when a clip loads, and only ever moves markers that
// are still where a fresh clip put them. Once a coach has dragged one, or a
// saved review brought its own, the markers are theirs: `snap()` is the only
// way to overwrite them, and it is a button the coach presses.

export type PhaseDetectionState =
  | { kind: "idle" }
  | { kind: "running"; progress: number }
  | { kind: "ready"; placed: number }
  | { kind: "failed"; message: string };

export interface SwingPhaseClip {
  id: string;
  sourceUrl: string;
  duration: number;
  fps?: number;
}

export interface UseSwingPhaseMarkersOptions {
  enabled: boolean;
  clip: SwingPhaseClip | null;
  markers: TimelineMarker[];
  defaults: (duration: number) => TimelineMarker[];
  apply: (next: TimelineMarker[]) => void;
}

/**
 * Loaded on first use: the detector and its frame walk are the lab's, and
 * nobody should download them until a clip is on screen.
 */
const loadDetector = () =>
  import("../../../../motion-lab/src/embed/detectSwingPhases").then((module) => module.detectSwingPhases);

export function useSwingPhaseMarkers({ enabled, clip, markers, defaults, apply }: UseSwingPhaseMarkersOptions) {
  const [state, setState] = useState<PhaseDetectionState>({ kind: "idle" });
  // Latest values for the async callbacks, which outlive the render that
  // started them.
  const markersRef = useRef(markers);
  const applyRef = useRef(apply);
  const defaultsRef = useRef(defaults);
  markersRef.current = markers;
  applyRef.current = apply;
  defaultsRef.current = defaults;
  /** The last clip's phases, so a snap after detection costs nothing. */
  const resultRef = useRef<{ clipId: string; phases: SwingPhases } | null>(null);

  const place = useCallback((phases: SwingPhases, duration: number, force: boolean) => {
    const current = markersRef.current;
    if (!force && !markersAreUntouched(current, defaultsRef.current(duration))) {
      setState({ kind: "ready", placed: 0 });
      return;
    }
    const { markers: next, placed } = placeMarkersAtPhases(current, phases, duration);
    if (placed.length) applyRef.current(next);
    setState({ kind: "ready", placed: placed.length });
  }, []);

  const clipId = clip?.id ?? null;
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const abortRef = useRef<AbortController | null>(null);

  const detect = useCallback(
    async (force: boolean) => {
      const target = clipRef.current;
      if (!target) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ kind: "running", progress: 0 });
      try {
        const [detectSwingPhases, blob] = await Promise.all([
          loadDetector(),
          fetch(target.sourceUrl).then((response) => {
            if (!response.ok) throw new Error(`The clip could not be read (${response.status}).`);
            return response.blob();
          }),
        ]);
        const phases = await detectSwingPhases(blob, {
          signal: controller.signal,
          fps: target.fps,
          onProgress: (progress) => {
            if (!controller.signal.aborted) setState({ kind: "running", progress });
          },
        });
        if (controller.signal.aborted || clipRef.current?.id !== target.id) return;
        resultRef.current = { clipId: target.id, phases };
        if (phases.failure) {
          setState({ kind: "failed", message: phases.failure });
          return;
        }
        place(phases, target.duration, force);
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          kind: "failed",
          message: error instanceof Error ? error.message : "Swing phases could not be found.",
        });
      }
    },
    [place]
  );

  useEffect(() => {
    resultRef.current = null;
    if (!enabled || !clipId) {
      abortRef.current?.abort();
      setState({ kind: "idle" });
      return;
    }
    void detect(false);
    return () => abortRef.current?.abort();
  }, [enabled, clipId, detect]);

  /** Put every marker on its phase, whatever the coach had done to them. */
  const snap = useCallback(() => {
    const target = clipRef.current;
    const cached = resultRef.current;
    if (target && cached?.clipId === target.id && !cached.phases.failure) {
      place(cached.phases, target.duration, true);
      return;
    }
    void detect(true);
  }, [detect, place]);

  return { state, snap };
}
