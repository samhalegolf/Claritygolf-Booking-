/**
 * Running a real video through the pipeline.
 *
 * Detection is slow -- tens of milliseconds a frame -- so this is built
 * around that fact rather than around hiding it: progress is reported per
 * frame, the run is cancellable, and the detector is torn down whatever
 * happens.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ClaritySequence } from "../contracts";
import { MediaPipeDetector } from "../observe/mediapipe/MediaPipeDetector";
import type { ObservationFrame } from "../observe/observation";
import { observeVideo, type ObservationResult } from "../observe/runObservation";
import { passthroughSequence } from "../motion/passthrough";

export type ObservationStatus = "idle" | "running" | "ready" | "error";

export interface VideoObservationState {
  readonly status: ObservationStatus;
  readonly progress: { readonly index: number; readonly total: number; readonly detected: number } | null;
  readonly error: string | null;
  readonly result: ObservationResult | null;
  readonly sequence: ClaritySequence | null;
  readonly raw: readonly ObservationFrame[];
  readonly videoUrl: string | null;
  readonly fileName: string | null;
}

const IDLE: VideoObservationState = {
  status: "idle",
  progress: null,
  error: null,
  result: null,
  sequence: null,
  raw: [],
  videoUrl: null,
  fileName: null,
};

export const useVideoObservation = () => {
  const [state, setState] = useState<VideoObservationState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // An object URL outlives the component unless it is revoked, and a few
  // hundred megabytes of video is not something to leak on a page the
  // developer will reload dozens of times.
  useEffect(() => () => {
    abortRef.current?.abort();
    revoke();
  }, [revoke]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const run = useCallback(
    async (file: File) => {
      cancel();
      revoke();

      const controller = new AbortController();
      abortRef.current = controller;

      const videoUrl = URL.createObjectURL(file);
      urlRef.current = videoUrl;

      setState({
        ...IDLE,
        status: "running",
        videoUrl,
        fileName: file.name,
        progress: { index: 0, total: 0, detected: 0 },
      });

      const detector = new MediaPipeDetector();

      try {
        const result = await observeVideo(file, {
          detector,
          signal: controller.signal,
          onProgress: (progress) =>
            setState((current) =>
              current.status === "running"
                ? {
                    ...current,
                    progress: {
                      index: progress.index,
                      total: progress.total,
                      detected: progress.detected,
                    },
                  }
                : current
            ),
        });

        if (controller.signal.aborted) return;

        setState({
          status: "ready",
          progress: null,
          error: null,
          result,
          // The naive baseline, not a reconstruction. What the detector said,
          // with holes left as holes.
          sequence: passthroughSequence(result.world),
          raw: result.raw,
          videoUrl,
          fileName: file.name,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          ...IDLE,
          status: "error",
          videoUrl,
          fileName: file.name,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        detector.close();
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [cancel, revoke]
  );

  const reset = useCallback(() => {
    cancel();
    revoke();
    setState(IDLE);
  }, [cancel, revoke]);

  return { state, run, cancel, reset };
};
