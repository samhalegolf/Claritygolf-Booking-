/**
 * Running real video through the pipeline.
 *
 * Detection is slow -- tens of milliseconds a frame -- so this is built
 * around that fact rather than around hiding it: progress is reported per
 * frame, the run is cancellable, and the detector is torn down whatever
 * happens.
 *
 * UP TO THREE CLIPS, DETECTED ONCE EACH
 *
 * A swing; optionally a standing shot to calibrate the camera's pitch from
 * (see `motion/level/standingShot`); and optionally a second angle of the
 * same swing -- face-on beside down the line -- to fuse with it (see
 * `motion/fuse/twoView`). Adding one must not re-detect another -- detection
 * is the expensive step and reconstruction is not, so every clip's
 * OBSERVATIONS are kept and the reconstruction is rebuilt from them whenever
 * any of them changes.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ClaritySequence } from "../contracts";
import { calibrateFromStandingShot, type StandingCalibration } from "../motion/level/standingShot";
import { MediaPipeDetector } from "../observe/mediapipe/MediaPipeDetector";
import type { CameraObservationSequence, ObservationFrame } from "../observe/observation";
import { observeVideo, type ObservationResult } from "../observe/runObservation";
import type { VideoSourceInfo } from "../observe/videoFrames";
import type { TwoViewReport } from "../motion/fuse/twoView";
import { buildVideoSequences, type LevellingReadout } from "./videoSequences";

export type ObservationStatus = "idle" | "running" | "ready" | "error";

type DetectPhase = "swing" | "standing" | "second";

export interface VideoObservationState {
  readonly status: ObservationStatus;
  readonly progress: {
    readonly index: number;
    readonly total: number;
    readonly detected: number;
    /** Which clip is being detected. The two take very different times. */
    readonly phase: DetectPhase;
  } | null;
  readonly error: string | null;
  readonly result: ObservationResult | null;
  /** The naive baseline: what the detector said, holes left as holes. */
  readonly sequence: ClaritySequence | null;
  /** The same observations through the full Motion Layer. */
  readonly reconstructed: ClaritySequence | null;
  readonly raw: readonly ObservationFrame[];
  readonly videoUrl: string | null;
  readonly fileName: string | null;
  /** The standing shot's verdict, once one has been measured. */
  readonly calibration: StandingCalibration | null;
  readonly calibrationFileName: string | null;
  readonly levelling: LevellingReadout | null;
  /** What fusing the second angle found. Null with no second angle. */
  readonly fusion: TwoViewReport | null;
  readonly secondAngleFileName: string | null;
  /**
   * The second angle, to watch beside the swing. Shown whether or not it
   * fused -- the coach should see what landed -- but only lined up with the
   * swing when `fusion` measured how.
   */
  readonly secondVideoUrl: string | null;
  readonly secondRaw: readonly ObservationFrame[];
  readonly secondInfo: VideoSourceInfo | null;
}

const IDLE: VideoObservationState = {
  status: "idle",
  progress: null,
  error: null,
  result: null,
  sequence: null,
  reconstructed: null,
  raw: [],
  videoUrl: null,
  fileName: null,
  calibration: null,
  calibrationFileName: null,
  levelling: null,
  fusion: null,
  secondAngleFileName: null,
  secondVideoUrl: null,
  secondRaw: [],
  secondInfo: null,
};

export const useVideoObservation = () => {
  const [state, setState] = useState<VideoObservationState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const secondUrlRef = useRef<string | null>(null);
  /*
   * The standing shot's OBSERVATIONS, not its verdict.
   *
   * Kept so that loading a swing afterwards costs one detection rather than
   * two, and so that the calibration is recomputed from the same evidence
   * rather than carried forward as a number nobody can check.
   */
  const standingRef = useRef<CameraObservationSequence | null>(null);
  /** The swing's observations, for the same reason in the other direction. */
  const swingRef = useRef<ObservationResult | null>(null);
  /** The second angle's observations. Belongs to one swing, so a new swing drops it. */
  const secondRef = useRef<CameraObservationSequence | null>(null);

  const revokeSecond = useCallback(() => {
    if (secondUrlRef.current) {
      URL.revokeObjectURL(secondUrlRef.current);
      secondUrlRef.current = null;
    }
  }, []);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    revokeSecond();
  }, [revokeSecond]);

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

  /** Detect one clip, reporting progress under the given phase. */
  const detect = useCallback(
    async (file: File, phase: DetectPhase, signal: AbortSignal) => {
      const detector = new MediaPipeDetector();
      try {
        return await observeVideo(file, {
          detector,
          signal,
          // A standing shot has no swing in it, so there is no clubhead to
          // look for. The second angle has one, but the club is taken from
          // the on-screen clip alone, so its frames are not spent on it.
          clubSearchWidth: phase === "swing" ? undefined : 0,
          onProgress: (progress) =>
            setState((current) =>
              current.status === "running"
                ? {
                    ...current,
                    progress: {
                      index: progress.index,
                      total: progress.total,
                      detected: progress.detected,
                      phase,
                    },
                  }
                : current
            ),
        });
      } finally {
        detector.close();
      }
    },
    []
  );

  /**
   * Rebuild from whatever observations are in hand. Cheap next to detection,
   * so it runs again whenever either clip changes. See `videoSequences`.
   */
  const rebuild = useCallback(
    (swing: ObservationResult) =>
      buildVideoSequences(swing, standingRef.current, secondRef.current),
    []
  );

  /** Detect a swing. Resolves true when it produced a result. */
  const run = useCallback(
    async (file: File): Promise<boolean> => {
      cancel();
      revoke();
      secondRef.current = null;

      const controller = new AbortController();
      abortRef.current = controller;

      const videoUrl = URL.createObjectURL(file);
      urlRef.current = videoUrl;

      setState((current) => ({
        ...IDLE,
        status: "running",
        videoUrl,
        fileName: file.name,
        // A standing shot already measured survives a new swing being loaded.
        calibration: current.calibration,
        calibrationFileName: current.calibrationFileName,
        progress: { index: 0, total: 0, detected: 0, phase: "swing" },
      }));

      try {
        const result = await detect(file, "swing", controller.signal);
        if (controller.signal.aborted) return false;
        swingRef.current = result;

        setState((current) => ({
          ...current,
          status: "ready",
          progress: null,
          error: null,
          result,
          raw: result.raw,
          videoUrl,
          fileName: file.name,
          ...rebuild(result),
        }));
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        setState((current) => ({
          ...IDLE,
          status: "error",
          videoUrl,
          fileName: file.name,
          calibration: current.calibration,
          calibrationFileName: current.calibrationFileName,
          error: error instanceof Error ? error.message : String(error),
        }));
        return false;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [cancel, detect, rebuild, revoke]
  );

  /**
   * Measure the camera's pitch from a clip of the golfer standing still.
   *
   * Does NOT touch the swing's object URL: the standing shot is evidence, not
   * something anyone wants to watch, so it is detected and discarded.
   */
  const runStandingShot = useCallback(
    async (file: File) => {
      cancel();

      const controller = new AbortController();
      abortRef.current = controller;

      setState((current) => ({
        ...current,
        status: "running",
        error: null,
        progress: { index: 0, total: 0, detected: 0, phase: "standing" },
      }));

      try {
        const shot = await detect(file, "standing", controller.signal);
        if (controller.signal.aborted) return;

        standingRef.current = shot.camera;
        const calibration = calibrateFromStandingShot(shot.camera);
        const swing = swingRef.current;

        setState((current) => ({
          ...current,
          status: swing ? "ready" : current.result ? "ready" : "idle",
          progress: null,
          calibration,
          calibrationFileName: file.name,
          // A swing already loaded is re-levelled with the new calibration,
          // without being detected again.
          ...(swing ? rebuild(swing) : {}),
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          status: "error",
          progress: null,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [cancel, detect, rebuild]
  );

  /** Drop the standing shot and fall back to what the swing can prove alone. */
  const clearStandingShot = useCallback(() => {
    standingRef.current = null;
    const swing = swingRef.current;
    setState((current) => ({
      ...current,
      ...(swing ? rebuild(swing) : { levelling: null }),
      calibration: null,
      calibrationFileName: null,
    }));
  }, [rebuild]);

  /**
   * Fuse a second angle of the same swing -- down the line beside face-on,
   * or the other way round. Like the standing shot it is evidence rather than
   * something to watch: the swing stays the clip on screen, and the second
   * angle only improves its 3D.
   */
  const runSecondAngle = useCallback(
    async (file: File) => {
      cancel();

      const controller = new AbortController();
      abortRef.current = controller;

      setState((current) => ({
        ...current,
        status: "running",
        error: null,
        progress: { index: 0, total: 0, detected: 0, phase: "second" },
      }));

      try {
        const shot = await detect(file, "second", controller.signal);
        if (controller.signal.aborted) return;

        secondRef.current = shot.camera;
        const swing = swingRef.current;
        revokeSecond();
        const secondVideoUrl = URL.createObjectURL(file);
        secondUrlRef.current = secondVideoUrl;

        setState((current) => ({
          ...current,
          status: swing ? "ready" : "idle",
          progress: null,
          secondAngleFileName: file.name,
          secondVideoUrl,
          secondRaw: shot.raw,
          secondInfo: shot.info,
          ...(swing ? rebuild(swing) : {}),
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          status: "error",
          progress: null,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [cancel, detect, rebuild, revokeSecond]
  );

  /** Drop the second angle and go back to the swing's own camera. */
  const clearSecondAngle = useCallback(() => {
    secondRef.current = null;
    revokeSecond();
    const swing = swingRef.current;
    setState((current) => ({
      ...current,
      ...(swing ? rebuild(swing) : { fusion: null }),
      secondAngleFileName: null,
      secondVideoUrl: null,
      secondRaw: [],
      secondInfo: null,
    }));
  }, [rebuild, revokeSecond]);

  const reset = useCallback(() => {
    cancel();
    revoke();
    standingRef.current = null;
    swingRef.current = null;
    secondRef.current = null;
    setState(IDLE);
  }, [cancel, revoke]);

  return {
    state,
    run,
    runStandingShot,
    clearStandingShot,
    runSecondAngle,
    clearSecondAngle,
    cancel,
    reset,
  };
};
