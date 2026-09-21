/**
 * The lab's keys: space plays, the arrows step, 1-4 pick a camera.
 *
 * Shared by the standalone shell and the embedded view so the two cannot
 * drift apart. `enabled` exists for the host: the booking app's video
 * workspace has its own space-and-arrows handler on the same window, and
 * the two must never both fire.
 */

import { useEffect } from "react";

import type { CameraPreset } from "../space3d/cameraRig";
import type { PlaybackControls } from "./usePlayback";

export const useLabKeyboard = (
  playback: PlaybackControls,
  onCameraPreset: (preset: CameraPreset) => void,
  enabled = true
) => {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (event: KeyboardEvent) => {
      // Never steal keys from a control the viewer is actually using.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

      switch (event.key) {
        case " ":
          event.preventDefault();
          playback.toggle();
          break;
        case "ArrowLeft":
          event.preventDefault();
          playback.step(event.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          event.preventDefault();
          playback.step(event.shiftKey ? 10 : 1);
          break;
        case "1":
          onCameraPreset("face-on");
          break;
        case "2":
          onCameraPreset("down-the-line");
          break;
        case "3":
          onCameraPreset("top");
          break;
        case "4":
          onCameraPreset("free");
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback, onCameraPreset, enabled]);
};
