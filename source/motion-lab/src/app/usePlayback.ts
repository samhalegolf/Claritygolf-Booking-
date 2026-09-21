/**
 * Playback over a frame sequence.
 *
 * Time is advanced in SECONDS and converted to a frame index, rather than
 * incrementing an index per animation frame. The display refreshes at
 * whatever rate the monitor runs at -- 60Hz, 120Hz, or whatever a browser
 * throttles to in a background tab -- and none of those match the clip's
 * frame rate. Counting display frames would make a 120Hz monitor play a
 * 60fps swing at double speed, which is the kind of bug that gets diagnosed
 * as "the detector is fast" for an afternoon.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface PlaybackState {
  readonly frameIndex: number;
  readonly playing: boolean;
  readonly speed: number;
  readonly loop: boolean;
}

export interface PlaybackControls extends PlaybackState {
  readonly play: () => void;
  readonly pause: () => void;
  readonly toggle: () => void;
  readonly seek: (frameIndex: number) => void;
  readonly step: (delta: number) => void;
  readonly setSpeed: (speed: number) => void;
  readonly setLoop: (loop: boolean) => void;
}

export const PLAYBACK_SPEEDS = [0.1, 0.25, 0.5, 1] as const;

export const usePlayback = (frameCount: number, fps: number): PlaybackControls => {
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  const [loop, setLoop] = useState(true);

  // The authoritative playhead, in frames, kept as a float so slow speeds
  // advance smoothly instead of quantising to whole frames per tick.
  const positionRef = useRef(0);
  const loopRef = useRef(loop);
  const speedRef = useRef(speed);
  loopRef.current = loop;
  speedRef.current = speed;

  const clampIndex = useCallback(
    (value: number) => Math.max(0, Math.min(frameCount - 1, value)),
    [frameCount]
  );

  const seek = useCallback(
    (next: number) => {
      const clamped = clampIndex(Math.round(next));
      positionRef.current = clamped;
      setFrameIndex(clamped);
    },
    [clampIndex]
  );

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      seek(positionRef.current + delta);
    },
    [seek]
  );

  useEffect(() => {
    if (!playing) return;

    let raf = 0;
    let previous = performance.now();

    const tick = (now: number) => {
      // Clamped so returning to a backgrounded tab does not jump the playhead
      // by however many seconds the tab was hidden.
      const delta = Math.min(0.25, (now - previous) / 1000);
      previous = now;

      positionRef.current += delta * fps * speedRef.current;

      if (positionRef.current >= frameCount - 1) {
        if (loopRef.current) {
          positionRef.current = 0;
        } else {
          positionRef.current = frameCount - 1;
          setFrameIndex(frameCount - 1);
          setPlaying(false);
          return;
        }
      }

      setFrameIndex(Math.floor(positionRef.current));
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, frameCount]);

  // A new clip resets the playhead rather than leaving it past the end.
  useEffect(() => {
    positionRef.current = 0;
    setFrameIndex(0);
  }, [frameCount]);

  return {
    frameIndex: clampIndex(frameIndex),
    playing,
    speed,
    loop,
    play: useCallback(() => setPlaying(true), []),
    pause: useCallback(() => setPlaying(false), []),
    toggle: useCallback(() => setPlaying((value) => !value), []),
    seek,
    step,
    setSpeed,
    setLoop,
  };
};
