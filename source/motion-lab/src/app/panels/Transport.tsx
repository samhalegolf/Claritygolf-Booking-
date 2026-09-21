/**
 * Play, step, speed and loop -- the row under the stage.
 */

import { PLAYBACK_SPEEDS, type PlaybackControls } from "../usePlayback";

export function Transport({
  playback,
  enabled,
}: {
  playback: PlaybackControls;
  /** False while nothing is loaded; every control is then inert. */
  enabled: boolean;
}) {
  return (
    <div className="lab-transport">
      <button type="button" className="lab-chip" onClick={playback.toggle} disabled={!enabled}>
        {playback.playing ? "Pause" : "Play"}
      </button>
      <button type="button" className="lab-chip" onClick={() => playback.step(-1)} disabled={!enabled}>
        ‹ Frame
      </button>
      <button type="button" className="lab-chip" onClick={() => playback.step(1)} disabled={!enabled}>
        Frame ›
      </button>

      <div className="lab-speed-group">
        {PLAYBACK_SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            className={speed === playback.speed ? "lab-chip lab-chip-active" : "lab-chip"}
            onClick={() => playback.setSpeed(speed)}
          >
            {speed}×
          </button>
        ))}
      </div>

      <label className="lab-toggle">
        <input
          type="checkbox"
          checked={playback.loop}
          onChange={(event) => playback.setLoop(event.target.checked)}
        />
        <span>Loop</span>
      </label>

      <span className="lab-transport-hint">
        space play · ← → step · shift for ten · 1–4 cameras
      </span>
    </div>
  );
}
