import { useCallback, useEffect, useRef } from "react";

interface KeyboardOptions {
  enabled?: boolean;
  onPlayPause: () => void;
  onPrevFrame: (holdFrames: number, shift: boolean) => void;
  onNextFrame: (holdFrames: number, shift: boolean) => void;
  onNudgeSelected?: (
    direction: -1 | 1,
    axis: "x" | "y",
    shift: boolean,
    heldFrames: number
  ) => void;
  drawingLayerHasFocus?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

interface RepeatState {
  direction: -1 | 1;
  axis: "x" | "y";
  startedAt: number;
  timerId: ReturnType<typeof setTimeout> | null;
  mode: "playback" | "nudge";
}

export function useKeyboardShortcuts({
  enabled = true,
  onPlayPause,
  onPrevFrame,
  onNextFrame,
  onNudgeSelected,
  drawingLayerHasFocus = false,
  onUndo,
  onRedo,
  onDelete,
  onCancel,
}: KeyboardOptions) {
  const repeatRef = useRef<RepeatState | null>(null);
  const shiftRef = useRef(false);
  const hasNudgeMode = !!onNudgeSelected && drawingLayerHasFocus;

  const clearRepeat = useCallback(() => {
    if (repeatRef.current?.timerId) {
      clearTimeout(repeatRef.current.timerId);
    }
    repeatRef.current = null;
    shiftRef.current = false;
  }, []);

  const schedule = useCallback(() => {
    if (!repeatRef.current) return;
    const elapsed = Date.now() - repeatRef.current.startedAt;
    let interval = 140;
    if (elapsed > 1300) interval = 35;
    else if (elapsed > 700) interval = 60;
    else if (elapsed > 350) interval = 90;
    const heldFrames = Math.max(1, Math.floor(elapsed / 260));

    if (!onNudgeSelected || repeatRef.current.mode === "playback" || !hasNudgeMode) {
      if (repeatRef.current.direction === -1) {
        onPrevFrame(heldFrames, shiftRef.current);
      } else {
        onNextFrame(heldFrames, shiftRef.current);
      }
    } else {
      onNudgeSelected(
        repeatRef.current.direction,
        repeatRef.current.axis,
        shiftRef.current,
        heldFrames
      );
    }
    repeatRef.current.timerId = setTimeout(schedule, interval);
  }, [onNudgeSelected, onNextFrame, onPrevFrame, hasNudgeMode]);

  const startRepeat = useCallback((
    direction: -1 | 1,
    axis: "x" | "y",
    mode: "playback" | "nudge"
  ) => {
    if (
      repeatRef.current?.direction === direction &&
      repeatRef.current?.axis === axis &&
      repeatRef.current?.mode === mode
    ) {
      return;
    }
    clearRepeat();
    repeatRef.current = {
      direction,
      axis,
      mode,
      startedAt: Date.now(),
      timerId: setTimeout(() => {
        schedule();
      }, 170),
    };

    if (mode === "nudge" && onNudgeSelected) {
      onNudgeSelected(direction, axis, shiftRef.current, 1);
      return;
    }

    // immediate one-off step
    if (direction === -1) {
      onPrevFrame(1, shiftRef.current);
    } else {
      onNextFrame(1, shiftRef.current);
    }
  }, [clearRepeat, onNudgeSelected, onNextFrame, onPrevFrame, schedule]);

  useEffect(() => {
    if (!enabled) return;

    // Protected boundary: keyboard-driven stepping/nudging should not continue after focus is lost.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || event.target.isContentEditable) {
          return;
        }
      }
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === "z") {
          if (event.shiftKey) {
            event.preventDefault();
            onRedo();
            return;
          }
          event.preventDefault();
          onUndo();
          return;
        }
      }
      if (event.key === "Shift") {
        shiftRef.current = true;
        return;
      }
      switch (event.code) {
        case "Space":
          event.preventDefault();
          onPlayPause();
          break;
        case "ArrowLeft":
          event.preventDefault();
          if (hasNudgeMode) {
            startRepeat(-1, "x", "nudge");
          } else {
            startRepeat(-1, "x", "playback");
          }
          break;
        case "ArrowRight":
          event.preventDefault();
          if (hasNudgeMode) {
            startRepeat(1, "x", "nudge");
          } else {
            startRepeat(1, "x", "playback");
          }
          break;
        case "ArrowUp":
          event.preventDefault();
          if (hasNudgeMode) {
            startRepeat(-1, "y", "nudge");
          }
          break;
        case "ArrowDown":
          event.preventDefault();
          if (hasNudgeMode) {
            startRepeat(1, "y", "nudge");
          }
          break;
        case "Backspace":
        case "Delete":
          event.preventDefault();
          onDelete();
          break;
        case "Escape":
          onCancel();
          break;
        default:
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftRef.current = false;
      if (
        event.code === "ArrowLeft" ||
        event.code === "ArrowRight" ||
        event.code === "ArrowUp" ||
        event.code === "ArrowDown"
      ) {
        clearRepeat();
      }
    };

    const onWindowBlur = () => clearRepeat();
    const onVisibilityChange = () => {
      if (document.hidden) {
        clearRepeat();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearRepeat();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    enabled,
    hasNudgeMode,
    clearRepeat,
    onCancel,
    startRepeat,
    onDelete,
    onNextFrame,
    onNudgeSelected,
    onPlayPause,
    onPrevFrame,
    onRedo,
    onUndo,
  ]);
}
