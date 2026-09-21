/**
 * The lab shell.
 *
 * Two sources, deliberately side by side:
 *
 *   SYNTHETIC  a known body, with faults injectable on demand. Proves the
 *              visualisation contract and the honesty layers against ground
 *              truth, which real footage can never provide.
 *
 *   VIDEO      MediaPipe on a real clip, through the real pipeline, rendered
 *              by the naive passthrough. No reconstruction yet -- holes stay
 *              holes. That is the control Build 3 will be measured against.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ClaritySpace3D } from "../space3d/ClaritySpace3D";
import type { CameraPreset } from "../space3d/cameraRig";
import { DEFAULT_LAYERS, type SceneLayers } from "../space3d/layers";
import type { StandingCalibration } from "../motion/level/standingShot";
import { ConfidencePanel } from "./panels/ConfidencePanel";
import { LayerPanel } from "./panels/LayerPanel";
import { MassPanel } from "./panels/MassPanel";
import { Timeline } from "./panels/Timeline";
import { VideoPanel } from "./panels/VideoPanel";
import { PIPELINE_MODES, SCENARIOS, type PipelineMode } from "./scenarios";
import { useSyntheticPipeline } from "./useSyntheticPipeline";
import { PLAYBACK_SPEEDS, usePlayback } from "./usePlayback";
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
    rejectJumps: true,
    validateReacquisition: true,
    bridgeGaps: true,
    constrain: true,
    smooth: true,
  });
  const [videoUseMotionLayer, setVideoUseMotionLayer] = useState(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const standingInputRef = useRef<HTMLInputElement | null>(null);

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

  const { status, progress, error, result, videoUrl, fileName, calibration, calibrationFileName, levelling } =
    video.state;

  return (
    <div className="lab">
      <header className="lab-header">
        <div className="lab-title">
          <h1>Clarity Motion Lab</h1>
          <p>Google observes, Clarity reconstructs, the 3D Space renders Clarity.</p>
        </div>

        <div className="source-picker">
          <div className="camera-buttons">
            <button
              type="button"
              className={source === "synthetic" ? "chip chip-active" : "chip"}
              onClick={() => setSource("synthetic")}
            >
              Synthetic
            </button>
            <button
              type="button"
              className={source === "video" ? "chip chip-active" : "chip"}
              onClick={() => setSource("video")}
            >
              Video
            </button>
          </div>

          {source === "synthetic" ? (
            <div className="scenario-picker">
              <div className="camera-buttons">
                {PIPELINE_MODES.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    title={entry.hint}
                    className={entry.key === pipelineMode ? "chip chip-active" : "chip"}
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
            <div className="scenario-picker">
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
              <input
                ref={standingInputRef}
                type="file"
                accept="video/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void video.runStandingShot(file);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="chip"
                onClick={() => fileInputRef.current?.click()}
                disabled={status === "running"}
              >
                {fileName ? "Choose another clip" : "Choose a clip"}
              </button>
              {/*
                The second clip, kept a separate button on purpose: it is a
                different kind of evidence, it is optional, and loading one
                must never be mistaken for loading a swing.
              */}
              <button
                type="button"
                className="chip"
                onClick={() => standingInputRef.current?.click()}
                disabled={status === "running"}
                title="Two seconds of the golfer standing still, from the same camera"
              >
                {calibrationFileName ? "Replace standing shot" : "Add standing shot"}
              </button>
              {calibrationFileName && (
                <button
                  type="button"
                  className="chip"
                  onClick={video.clearStandingShot}
                  disabled={status === "running"}
                >
                  Drop it
                </button>
              )}
              {status === "running" && (
                <button type="button" className="chip" onClick={video.cancel}>
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <p className="scenario-purpose">
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
            <div className="panel">
              <h2 className="panel-title">Against ground truth</h2>
              <div className="score-headline">
                <span className="score-value">
                  {synthetic.errorVsTruthM === null
                    ? "—"
                    : (synthetic.errorVsTruthM * 1000).toFixed(1)}
                </span>
                <span className="score-scale">mm mean joint error</span>
              </div>
              <p className="panel-note">
                Averaged over every joint of every frame, against the body the
                detector was shown. The only number here that measures whether the
                reconstruction is <em>right</em> rather than merely smooth — switch
                between Baseline and Motion Layer to see what the layer buys.
              </p>

              {pipelineMode === "motion-layer" && (
                <>
                  <h3 className="panel-subtitle">Stages</h3>
                  {(
                    [
                      ["rejectJumps", "Reject jumps"],
                      ["validateReacquisition", "Validate returns"],
                      ["bridgeGaps", "Bridge gaps"],
                      ["constrain", "Physical constraints"],
                      ["smooth", "Smoothing"],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="toggle" key={key}>
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
                  <p className="panel-note">
                    Turn one off and watch the error above. A stage that changes
                    nothing is not earning its place.
                  </p>

                  {synthetic.stageCounts && (
                    <dl className="readout">
                      {Object.entries(synthetic.stageCounts).map(([key, value]) => (
                        <div className="readout-row" key={key}>
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
            <div className="panel">
              <h2 className="panel-title">Observation</h2>
              {status === "idle" && (
                <>
                  <p className="panel-note">
                    Pick a clip. Every frame is seeked to and detected in order, so
                    nothing is skipped — which is slower than playback and the reason
                    a gap downstream means the detector lost the golfer rather than
                    that we outran it.
                  </p>
                  {/*
                    A standing shot can be loaded FIRST, and when it is there is
                    no swing and no result to hang its verdict off. Showing it
                    here is the difference between "measured, waiting for a
                    swing" and the user believing nothing happened.
                  */}
                  {calibration && (
                    <StandingShotReadout
                      calibration={calibration}
                      fileName={calibrationFileName}
                    />
                  )}
                </>
              )}
              {status === "running" && progress && (
                <>
                  <dl className="readout">
                    <div className="readout-row">
                      <dt>Detecting</dt>
                      <dd>{progress.phase === "standing" ? "standing shot" : "the swing"}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Frame</dt>
                      <dd>
                        {progress.index} / {progress.total}
                      </dd>
                    </div>
                    <div className="readout-row">
                      <dt>Detected</dt>
                      <dd>{progress.detected}</dd>
                    </div>
                  </dl>
                  <span className="bar" aria-hidden="true">
                    <span
                      className="bar-fill"
                      style={{
                        width: `${
                          progress.total > 0
                            ? Math.round((progress.index / progress.total) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </span>
                </>
              )}
              {status === "error" && <p className="panel-error">{error}</p>}
              {status === "ready" && result && (
                <>
                  <dl className="readout">
                    <div className="readout-row">
                      <dt>Detector</dt>
                      <dd>{result.camera.detector}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Frames</dt>
                      <dd>{result.camera.frames.length}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Measured fps</dt>
                      <dd>{result.info.fps}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Undetected</dt>
                      <dd>{result.undetectedFrames}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Duplicate decodes</dt>
                      <dd>{result.duplicateDecodes}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Clubhead found in</dt>
                      <dd>
                        {result.clubDetections} / {result.camera.frames.length}
                      </dd>
                    </div>
                    <div className="readout-row">
                      <dt>Anchor frame</dt>
                      <dd>{result.world.anchor.anchorFrameIndex}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Anchor stable</dt>
                      <dd>{result.world.anchor.anchorIsStable ? "yes" : "no"}</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Stance width</dt>
                      <dd>{result.world.anchor.stanceWidthM.toFixed(3)} m</dd>
                    </div>
                    <div className="readout-row">
                      <dt>Standing shot</dt>
                      <dd>
                        {!calibration
                          ? "none"
                          : calibration.usable
                            ? `${calibration.pitchDeg >= 0 ? "+" : ""}${calibration.pitchDeg.toFixed(2)}° pitch`
                            : "refused"}
                      </dd>
                    </div>
                    <div className="readout-row">
                      <dt>Camera roll</dt>
                      <dd>
                        {result.world.anchor.gravityTiltIsMeasured
                          ? `${result.world.anchor.gravityTiltDeg.toFixed(2)}°`
                          : "not measured"}
                      </dd>
                    </div>
                    <div className="readout-row">
                      <dt>Took</dt>
                      <dd>{(result.elapsedMs / 1000).toFixed(1)} s</dd>
                    </div>
                  </dl>
                  {calibration && !calibration.usable && (
                    <p className="panel-note">
                      Standing shot refused: {calibration.reason}. The world is
                      levelled from what the swing can prove on its own instead,
                      which is a lower bound rather than a measurement.
                    </p>
                  )}
                  {levelling?.agreement === "boundary-forced-more" && (
                    <p className="panel-note">
                      The standing shot and the swing disagree. The shot asked for{" "}
                      {calibration?.pitchDeg.toFixed(2)}°, but the swing still put the
                      golfer&rsquo;s mass outside their feet, so a further{" "}
                      {levelling.boundaryResidualDeg.toFixed(2)}° was forced on top.
                      Physics wins that argument — but the usual cause is the two
                      clips being filmed from different places, which no correction
                      can undo.
                    </p>
                  )}
                  {levelling?.source === "standing-shot" &&
                    levelling.agreement === "agree" &&
                    !levelling.calibrationWithinBoundary && (
                      <p className="panel-note">
                        The standing shot claims a pitch the swing says is
                        impossible. Treat this reconstruction as unreliable and
                        check that both clips came from the same camera position.
                      </p>
                    )}
                  {!result.world.anchor.gravityTiltIsMeasured && (
                    <p className="panel-note">
                      No frame had the golfer standing on both feet, so there was
                      no horizontal line to measure against. This world is level
                      only because nothing was done to it — which is not the same
                      as a camera that was level.
                    </p>
                  )}
                  {!result.world.anchor.anchorIsStable && (
                    <p className="panel-note">
                      No still frame with both feet visible was found, so the world
                      axes are a best guess and every coordinate inherits that doubt.
                    </p>
                  )}
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={showLowConfidence}
                      onChange={(event) => setShowLowConfidence(event.target.checked)}
                    />
                    <span>Overlay: show low-confidence landmarks</span>
                  </label>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={videoUseMotionLayer}
                      onChange={(event) => setVideoUseMotionLayer(event.target.checked)}
                    />
                    <span>Reconstruct (Motion Layer)</span>
                  </label>
                </>
              )}
            </div>
          )}
        </aside>

        <main className="lab-stage">
          <div className={source === "video" && videoUrl ? "stage-split" : "stage-single"}>
            {source === "video" && videoUrl && (
              <VideoPanel
                videoUrl={videoUrl}
                frame={rawFrame}
                width={result?.info.width ?? 16}
                height={result?.info.height ?? 9}
                showLowConfidence={showLowConfidence}
              />
            )}

            <div className="stage-canvas">
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
                <div className="stage-empty">
                  {status === "running" ? "Detecting…" : "No sequence loaded."}
                </div>
              )}
            </div>
          </div>

          <div className="transport">
            <button type="button" className="chip" onClick={playback.toggle} disabled={!sequence}>
              {playback.playing ? "Pause" : "Play"}
            </button>
            <button type="button" className="chip" onClick={() => playback.step(-1)} disabled={!sequence}>
              ‹ Frame
            </button>
            <button type="button" className="chip" onClick={() => playback.step(1)} disabled={!sequence}>
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
            <div className="panel">
              <h2 className="panel-title">Reconstruction confidence</h2>
              <p className="panel-note">Nothing loaded.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * What a standing shot measured, on its own terms.
 *
 * Shown before a swing has been loaded as well as after, because a standing
 * shot is evidence in its own right and the two clips can arrive in either
 * order. Without this, loading the calibration first looks like nothing
 * happened at all.
 */
function StandingShotReadout({
  calibration,
  fileName,
}: {
  calibration: StandingCalibration;
  fileName: string | null;
}) {
  return (
    <>
      <dl className="readout">
        <div className="readout-row">
          <dt>Standing shot</dt>
          <dd>{fileName ?? "loaded"}</dd>
        </div>
        <div className="readout-row">
          <dt>Camera pitch</dt>
          <dd>
            {calibration.usable
              ? `${calibration.pitchDeg >= 0 ? "+" : ""}${calibration.pitchDeg.toFixed(2)}°`
              : "refused"}
          </dd>
        </div>
        <div className="readout-row">
          <dt>Range</dt>
          <dd>
            {calibration.pitchRangeDeg[0].toFixed(2)}° … {calibration.pitchRangeDeg[1].toFixed(2)}°
          </dd>
        </div>
        <div className="readout-row">
          <dt>Stood off plumb by</dt>
          <dd>{(calibration.standingBendM * 1000).toFixed(0)} mm</dd>
        </div>
        <div className="readout-row">
          <dt>Still frames used</dt>
          <dd>{calibration.samples}</dd>
        </div>
      </dl>
      <p className="panel-note">
        {calibration.usable
          ? "Measured. Load a swing filmed from the same camera position and it will be levelled with this rather than with the lower bound the swing can prove on its own."
          : `Refused: ${calibration.reason}.`}
      </p>
    </>
  );
}
