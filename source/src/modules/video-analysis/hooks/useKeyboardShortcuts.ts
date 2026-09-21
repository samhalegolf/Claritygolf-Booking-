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
  /**
   * Space, because a screenshot is taken while watching -- eyes on the swing,
   * hand finding the key without looking, and Space is the only key you can
   * hit blind. Playback moves to K, which is what every editor uses. Where
   * there is nothing to capture (the player's workspace) Space stays on
   * play/pause rather than becoming a dead key.
   */
  onCapture?: () => void;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
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
  onCapture,
  onSave,
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
    // Stepping frames with the arrows is the main way this workspace gets
    // used, so a hold starts gently -- the first half second is still for
    // picking out one frame -- and then winds up to roughly twice the old
    // top speed for travelling across a swing.
    const elapsed = Date.now() - repeatRef.current.startedAt;
    let interval = 110;
    if (elapsed > 2000) interval = 24;
    else if (elapsed > 1200) interval = 32;
    else if (elapsed > 650) interval = 50;
    else if (elapsed > 300) interval = 70;
    const heldFrames = Math.max(1, Math.floor(elapsed / 220));

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
      }, 130),
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
        if (onSave && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSave();
          return;
        }
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
          if (!onCapture) {
            onPlayPause();
            break;
          }
          // Held, not tapped: one press is one picture.
          if (!event.repeat) onCapture();
          break;
        case "KeyK":
          event.preventDefault();
          if (!event.repeat) onPlayPause();
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
          // Another undo key, within reach of the hand that is not on the
          // mouse. Dialogs that need Escape to mean "close" handle it
          // themselves before it reaches here.
          event.preventDefault();
          onUndo();
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
    onCapture,
    onSave,
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
