/**
 * The motion lab as a component another app can mount.
 *
 * The standalone shell (app/LabApp) chooses between a synthetic body and a
 * video file. This is the video half on its own: the host hands it a swing
 * it has already loaded, and the view detects it, reconstructs it and
 * renders it, with the same panels, transport and keys as the lab page.
 *
 * WHAT THE HOST IS RESPONSIBLE FOR
 *
 *   - The swing. A Blob plus a name; the view never asks for a file of its
 *     own, because in the booking app the clip is already on screen and a
 *     second picker would be a second source of truth about which swing
 *     this is. The standing shot is different -- it is extra evidence the
 *     workspace knows nothing about -- so its buttons live here.
 *   - Keyboard arbitration. The view listens for space and the arrows on
 *     the window while `keysEnabled` is true; a host with shortcuts of its
 *     own on the same keys must switch them off while this is open.
 *   - The box. `.lab` fills its container; give it one with a height.
 *
 * The rule the whole lab is built on still holds inside a host: Google
 * observes, Clarity reconstructs, the 3D Space renders Clarity. Nothing the
 * host passes in reaches the renderer except through a ClarityFrame.
 */

import { useCallback, useEffect, useState } from "react";

import { ClaritySpace3D } from "../space3d/ClaritySpace3D";
import type { CameraPreset } from "../space3d/cameraRig";
import { DEFAULT_LAYERS, type SceneLayers } from "../space3d/layers";
import { ConfidencePanel } from "../app/panels/ConfidencePanel";
import { LayerPanel } from "../app/panels/LayerPanel";
import { MassPanel } from "../app/panels/MassPanel";
import { ObservationPanel } from "../app/panels/ObservationPanel";
import { StandingShotButtons } from "../app/panels/StandingShotButtons";
import { Timeline } from "../app/panels/Timeline";
import { Transport } from "../app/panels/Transport";
import { VideoPanel } from "../app/panels/VideoPanel";
import { useLabKeyboard } from "../app/useLabKeyboard";
import { usePlayback } from "../app/usePlayback";
import { useVideoObservation } from "../app/useVideoObservation";
import "../app/lab.css";

export interface MotionLabSwing {
  readonly blob: Blob;
  /** Shown in the header and used as the detector's file name. */
  readonly name: string;
}

export interface MotionLabViewProps {
  /**
   * The swing to analyse. Detection starts when this changes identity, so a
   * host should hold it in state rather than build a fresh object per render.
   */
  readonly swing: MotionLabSwing | null;
  /** A line for the header, such as the player's name. */
  readonly title?: string;
  /** Whether the lab may own space and the arrow keys right now. */
  readonly keysEnabled?: boolean;
  readonly onClose?: () => void;
}

export function MotionLabView({ swing, title, keysEnabled = true, onClose }: MotionLabViewProps) {
  const [layers, setLayers] = useState<SceneLayers>(DEFAULT_LAYERS);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>("face-on");
  const [showLowConfidence, setShowLowConfidence] = useState(true);
  const [useMotionLayer, setUseMotionLayer] = useState(true);

  const video = useVideoObservation();
  const { run } = video;

  // A File rather than the Blob so the detector has a name to report. No
  // bytes are copied: a File built from a Blob references the same parts.
  useEffect(() => {
    if (!swing) return;
    void run(new File([swing.blob], swing.name, { type: swing.blob.type }));
  }, [swing, run]);

  const sequence = useMotionLayer ? video.state.reconstructed : video.state.sequence;
  const frameCount = sequence?.frames.length ?? 0;
  const playback = usePlayback(frameCount, sequence?.fps ?? 60);
  const frame = sequence?.frames[playback.frameIndex] ?? null;
  const rawFrame = video.state.raw[playback.frameIndex] ?? null;

  const toggleLayer = useCallback((key: keyof SceneLayers, value: boolean) => {
    setLayers((current) => ({ ...current, [key]: value }));
  }, []);

  const onCameraTakenOver = useCallback(() => {
    setCameraPreset((current) => (current === "free" ? current : "free"));
  }, []);

  useLabKeyboard(playback, setCameraPreset, keysEnabled);

  useEffect(() => {
    if (!onClose || !keysEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keysEnabled]);

  const { status, result, videoUrl, calibrationFileName } = video.state;

  return (
    <div className="lab lab-embedded">
      <header className="lab-header">
        <div className="lab-title">
          <h1>{title ? `${title} · 3D motion` : "3D motion"}</h1>
          <p>
            {swing ? `${swing.name} — ` : ""}
            Google observes, Clarity reconstructs, the 3D Space renders Clarity.
          </p>
        </div>

        <div className="lab-source-picker">
          <StandingShotButtons
            status={status}
            calibrationFileName={calibrationFileName}
            onPick={(file) => void video.runStandingShot(file)}
            onClear={video.clearStandingShot}
            onCancel={video.cancel}
          />
          {onClose && (
            <button type="button" className="lab-chip" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </header>

      <div className="lab-body">
        <aside className="lab-rail">
          <LayerPanel
            layers={layers}
            onToggle={toggleLayer}
            cameraPreset={cameraPreset}
            onCameraPreset={setCameraPreset}
          />
          <ObservationPanel
            state={video.state}
            showLowConfidence={showLowConfidence}
            onShowLowConfidence={setShowLowConfidence}
            useMotionLayer={useMotionLayer}
            onUseMotionLayer={setUseMotionLayer}
          />
        </aside>

        <main className="lab-stage">
          <div className={videoUrl ? "lab-stage-split" : "lab-stage-single"}>
            {videoUrl && (
              <VideoPanel
                videoUrl={videoUrl}
                frame={rawFrame}
                width={result?.info.width ?? 16}
                height={result?.info.height ?? 9}
                showLowConfidence={showLowConfidence}
              />
            )}

            <div className="lab-stage-canvas">
              {sequence && frame ? (
                <ClaritySpace3D
                  sequence={sequence}
                  frame={frame}
                  layers={layers}
                  cameraPreset={cameraPreset}
                  onCameraTakenOver={onCameraTakenOver}
                />
              ) : (
                <div className="lab-stage-empty">
                  {status === "running"
                    ? "Detecting…"
                    : status === "error"
                      ? "Detection failed."
                      : swing
                        ? "Preparing…"
                        : "No swing loaded."}
                </div>
              )}
            </div>
          </div>

          <Transport playback={playback} enabled={Boolean(sequence)} />

          {sequence && (
            <Timeline sequence={sequence} frameIndex={playback.frameIndex} onSeek={playback.seek} />
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
