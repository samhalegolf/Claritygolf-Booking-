/**
 * The lab shell.
 *
 * Two sources, deliberately side by side:
 *
 *   SYNTHETIC  a known body, with faults injectable on demand. Proves the
 *              visualisation contract and the honesty layers against ground
 *              truth, which real footage can never provide.
 *
 *   VIDEO      MediaPipe on a real clip, through the real pipeline, with the
 *              Motion Layer switchable against the do-nothing baseline.
 *
 * The video half is the same set of panels the booking app mounts through
 * embed/MotionLabView; what this shell adds is the synthetic source, the
 * scenario picker and a file picker of its own.
 */

import { useCallback, useRef, useState } from "react";

import { ClaritySpace3D } from "../space3d/ClaritySpace3D";
import type { CameraPreset } from "../space3d/cameraRig";
import { DEFAULT_LAYERS, type SceneLayers } from "../space3d/layers";
import { ConfidencePanel } from "./panels/ConfidencePanel";
import { LayerPanel } from "./panels/LayerPanel";
import { MassPanel } from "./panels/MassPanel";
import { ObservationPanel } from "./panels/ObservationPanel";
import { StandingShotButtons } from "./panels/StandingShotButtons";
import { Timeline } from "./panels/Timeline";
import { Transport } from "./panels/Transport";
import { VideoPanel } from "./panels/VideoPanel";
import { PIPELINE_MODES, SCENARIOS, type PipelineMode } from "./scenarios";
import { useLabKeyboard } from "./useLabKeyboard";
import { useSyntheticPipeline } from "./useSyntheticPipeline";
import { usePlayback } from "./usePlayback";
import { useVideoObservation } from "./useVideoObservation";

type Source = "synthetic" | "video";

export function LabApp() {
  const [source, setSource] = useState<Source>("synthetic");
  const [scenarioKey, setScenarioKey] = useState(SCENARIOS[0].key);
  const [layers, setLayers] = useState<SceneLayers>(DEFAULT_LAYERS);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>("face-on");
  const [showLowConfidence, setShowLowConfidence] = useState(true);
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>("truth");
  const [stages, setStages] = useState({
    rejectContradictions: true,
    rejectJumps: true,
    validateReacquisition: true,
    bridgeGaps: true,
    constrain: true,
    smooth: true,
  });
  const [videoUseMotionLayer, setVideoUseMotionLayer] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const scenario = SCENARIOS.find((entry) => entry.key === scenarioKey) ?? SCENARIOS[0];
  const synthetic = useSyntheticPipeline(scenario, pipelineMode, stages);

  const video = useVideoObservation();
  const videoSequence = videoUseMotionLayer
    ? video.state.reconstructed
    : video.state.sequence;

  const sequence = source === "video" ? videoSequence : synthetic.sequence;
  const ballPosition = source === "synthetic" ? synthetic.ballPosition : undefined;

  const frameCount = sequence?.frames.length ?? 0;
  const playback = usePlayback(frameCount, sequence?.fps ?? 60);
  const frame = sequence?.frames[playback.frameIndex] ?? null;
  const rawFrame = source === "video" ? video.state.raw[playback.frameIndex] ?? null : null;

  const toggleLayer = useCallback((key: keyof SceneLayers, value: boolean) => {
    setLayers((current) => ({ ...current, [key]: value }));
  }, []);

  const onCameraTakenOver = useCallback(() => {
    setCameraPreset((current) => (current === "free" ? current : "free"));
  }, []);

  useLabKeyboard(playback, setCameraPreset);

  const { status, result, videoUrl, fileName, calibrationFileName } = video.state;

  return (
    <div className="lab">
      <header className="lab-header">
        <div className="lab-title">
          <h1>Clarity Motion Lab</h1>
          <p>Google observes, Clarity reconstructs, the 3D Space renders Clarity.</p>
        </div>

        <div className="lab-source-picker">
          <div className="lab-camera-buttons">
            <button
              type="button"
              className={source === "synthetic" ? "lab-chip lab-chip-active" : "lab-chip"}
              onClick={() => setSource("synthetic")}
            >
              Synthetic
            </button>
            <button
              type="button"
              className={source === "video" ? "lab-chip lab-chip-active" : "lab-chip"}
              onClick={() => setSource("video")}
            >
              Video
            </button>
          </div>

          {source === "synthetic" ? (
            <div className="lab-scenario-picker">
              <div className="lab-camera-buttons">
                {PIPELINE_MODES.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    title={entry.hint}
                    className={entry.key === pipelineMode ? "lab-chip lab-chip-active" : "lab-chip"}
                    onClick={() => setPipelineMode(entry.key)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
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
          ) : (
            <div className="lab-scenario-picker">
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void video.run(file);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="lab-chip"
                onClick={() => fileInputRef.current?.click()}
                disabled={status === "running"}
              >
                {fileName ? "Choose another clip" : "Choose a clip"}
              </button>
              <StandingShotButtons
                status={status}
                calibrationFileName={calibrationFileName}
                onPick={(file) => void video.runStandingShot(file)}
                onClear={video.clearStandingShot}
                onCancel={video.cancel}
              />
            </div>
          )}
        </div>
      </header>

      <p className="lab-scenario-purpose">
        {source === "synthetic"
          ? scenario.purpose
          : "MediaPipe on a real clip, through the real pipeline. Toggle the Motion Layer to compare reconstruction against the do-nothing baseline. Add a standing shot — two seconds of the golfer standing still, same camera — to measure the camera's pitch instead of merely bounding it."}
      </p>

      <div className="lab-body">
        <aside className="lab-rail">
          <LayerPanel
            layers={layers}
            onToggle={toggleLayer}
            cameraPreset={cameraPreset}
            onCameraPreset={setCameraPreset}
          />

          {source === "synthetic" && pipelineMode !== "truth" && (
            <div className="lab-panel">
              <h2 className="lab-panel-title">Against ground truth</h2>
              <div className="lab-score-headline">
                <span className="lab-score-value">
                  {synthetic.errorVsTruthM === null
                    ? "—"
                    : (synthetic.errorVsTruthM * 1000).toFixed(1)}
                </span>
                <span className="lab-score-scale">mm mean joint error</span>
              </div>
              <p className="lab-panel-note">
                Averaged over every joint of every frame, against the body the
                detector was shown. The only number here that measures whether the
                reconstruction is <em>right</em> rather than merely smooth — switch
                between Baseline and Motion Layer to see what the layer buys.
              </p>

              {pipelineMode === "motion-layer" && (
                <>
                  <h3 className="lab-panel-subtitle">Stages</h3>
                  {(
                    [
                      ["rejectContradictions", "Reject contradictions"],
                      ["rejectJumps", "Reject jumps"],
                      ["validateReacquisition", "Validate returns"],
                      ["bridgeGaps", "Bridge gaps"],
                      ["constrain", "Physical constraints"],
                      ["smooth", "Smoothing"],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="lab-toggle" key={key}>
                      <input
                        type="checkbox"
                        checked={stages[key]}
                        onChange={(event) =>
                          setStages((current) => ({ ...current, [key]: event.target.checked }))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                  <p className="lab-panel-note">
                    Turn one off and watch the error above. A stage that changes
                    nothing is not earning its place.
                  </p>

                  {synthetic.stageCounts && (
                    <dl className="lab-readout">
                      {Object.entries(synthetic.stageCounts).map(([key, value]) => (
                        <div className="lab-readout-row" key={key}>
                          <dt>{key.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </>
              )}
            </div>
          )}

          {source === "video" && (
            <ObservationPanel
              state={video.state}
              showLowConfidence={showLowConfidence}
              onShowLowConfidence={setShowLowConfidence}
              useMotionLayer={videoUseMotionLayer}
              onUseMotionLayer={setVideoUseMotionLayer}
            />
          )}
        </aside>

        <main className="lab-stage">
          <div className={source === "video" && videoUrl ? "lab-stage-split" : "lab-stage-single"}>
            {source === "video" && videoUrl && (
              <VideoPanel
                videoUrl={videoUrl}
                frame={rawFrame}
                width={result?.info.width ?? 16}
                height={result?.info.height ?? 9}
                showLowConfidence={showLowConfidence}
                layers={layers}
              />
            )}

            <div className="lab-stage-canvas">
              {sequence && frame ? (
                <ClaritySpace3D
                  sequence={sequence}
                  frame={frame}
                  layers={layers}
                  cameraPreset={cameraPreset}
                  ballPosition={ballPosition}
                  onCameraTakenOver={onCameraTakenOver}
                />
              ) : (
                <div className="lab-stage-empty">
                  {status === "running" ? "Detecting…" : "No sequence loaded."}
                </div>
              )}
            </div>
          </div>

          <Transport playback={playback} enabled={Boolean(sequence)} />

          {sequence && (
            <Timeline
              sequence={sequence}
              frameIndex={playback.frameIndex}
              onSeek={playback.seek}
            />
          )}
        </main>

        <aside className="lab-rail lab-rail-right">
          {sequence && frame ? (
            <>
              <ConfidencePanel frame={frame} sequence={sequence} />
              <MassPanel frame={frame} sequence={sequence} />
            </>
          ) : (
            <div className="lab-panel">
              <h2 className="lab-panel-title">Reconstruction confidence</h2>
              <p className="lab-panel-note">Nothing loaded.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
