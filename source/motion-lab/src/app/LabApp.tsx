/**
 * The lab shell.
 *
 * Build 1: the 3D Space, driven entirely by synthetic ClarityFrames. No
 * detector is involved, and that is the point -- if the whole visualisation
 * contract can be proved from fixture data, MediaPipe becomes a swappable
 * input rather than a prerequisite.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ClaritySpace3D } from "../space3d/ClaritySpace3D";
import type { CameraPreset } from "../space3d/cameraRig";
import { DEFAULT_LAYERS, type SceneLayers } from "../space3d/layers";
import { ConfidencePanel } from "./panels/ConfidencePanel";
import { LayerPanel } from "./panels/LayerPanel";
import { MassPanel } from "./panels/MassPanel";
import { Timeline } from "./panels/Timeline";
import { SCENARIOS, buildScenario } from "./scenarios";
import { PLAYBACK_SPEEDS, usePlayback } from "./usePlayback";

export function LabApp() {
  const [scenarioKey, setScenarioKey] = useState(SCENARIOS[0].key);
  const [layers, setLayers] = useState<SceneLayers>(DEFAULT_LAYERS);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>("face-on");

  const scenario = SCENARIOS.find((entry) => entry.key === scenarioKey) ?? SCENARIOS[0];
  // Regenerating a swing walks the whole schedule and solves IK per frame, so
  // it is memoised on the scenario rather than run on every render.
  const swing = useMemo(() => buildScenario(scenario), [scenario]);

  const playback = usePlayback(swing.frames.length, swing.fps);
  const frame = swing.frames[playback.frameIndex] ?? swing.frames[0];

  const toggleLayer = useCallback((key: keyof SceneLayers, value: boolean) => {
    setLayers((current) => ({ ...current, [key]: value }));
  }, []);

  const onCameraTakenOver = useCallback(() => {
    setCameraPreset((current) => (current === "free" ? current : "free"));
  }, []);

  /* ---- keyboard ---- */

  useEffect(() => {
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
          setCameraPreset("face-on");
          break;
        case "2":
          setCameraPreset("down-the-line");
          break;
        case "3":
          setCameraPreset("top");
          break;
        case "4":
          setCameraPreset("free");
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback]);

  return (
    <div className="lab">
      <header className="lab-header">
        <div className="lab-title">
          <h1>Clarity Motion Lab</h1>
          <p>
            Build 1 — the 3D Space, on synthetic ClarityFrames. Google observes,
            Clarity reconstructs, this renders Clarity.
          </p>
        </div>

        <div className="scenario-picker">
          <label htmlFor="scenario">Scenario</label>
          <select
            id="scenario"
            value={scenarioKey}
            onChange={(event) => setScenarioKey(event.target.value)}
          >
            {SCENARIOS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <p className="scenario-purpose">{scenario.purpose}</p>

      <div className="lab-body">
        <aside className="lab-rail">
          <LayerPanel
            layers={layers}
            onToggle={toggleLayer}
            cameraPreset={cameraPreset}
            onCameraPreset={setCameraPreset}
          />
        </aside>

        <main className="lab-stage">
          <div className="stage-canvas">
            <ClaritySpace3D
              sequence={swing}
              frame={frame}
              layers={layers}
              cameraPreset={cameraPreset}
              ballPosition={swing.ballPosition}
              onCameraTakenOver={onCameraTakenOver}
            />
          </div>

          <div className="transport">
            <button type="button" className="chip" onClick={playback.toggle}>
              {playback.playing ? "Pause" : "Play"}
            </button>
            <button type="button" className="chip" onClick={() => playback.step(-1)}>
              ‹ Frame
            </button>
            <button type="button" className="chip" onClick={() => playback.step(1)}>
              Frame ›
            </button>

            <div className="speed-group">
              {PLAYBACK_SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={speed === playback.speed ? "chip chip-active" : "chip"}
                  onClick={() => playback.setSpeed(speed)}
                >
                  {speed}×
                </button>
              ))}
            </div>

            <label className="toggle">
              <input
                type="checkbox"
                checked={playback.loop}
                onChange={(event) => playback.setLoop(event.target.checked)}
              />
              <span>Loop</span>
            </label>

            <span className="transport-hint">
              space play · ← → step · shift for ten · 1–4 cameras
            </span>
          </div>

          <Timeline sequence={swing} frameIndex={playback.frameIndex} onSeek={playback.seek} />
        </main>

        <aside className="lab-rail lab-rail-right">
          <ConfidencePanel frame={frame} sequence={swing} />
          <MassPanel frame={frame} />
        </aside>
      </div>
    </div>
  );
}
