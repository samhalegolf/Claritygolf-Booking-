/**
 * What the detector did with the clip, and what the levelling made of it.
 *
 * One panel for all four states of a video run -- idle, running, error,
 * ready -- so the reader always has the same place to look. The readouts
 * are deliberately plain numbers: this build is still finding out which of
 * them matter, and a verdict here would be a guess dressed as one.
 */

import type { StandingCalibration } from "../../motion/level/standingShot";
import type { VideoObservationState } from "../useVideoObservation";

export function ObservationPanel({
  state,
  showLowConfidence,
  onShowLowConfidence,
  useMotionLayer,
  onUseMotionLayer,
}: {
  state: VideoObservationState;
  showLowConfidence: boolean;
  onShowLowConfidence: (value: boolean) => void;
  useMotionLayer: boolean;
  onUseMotionLayer: (value: boolean) => void;
}) {
  const { status, progress, error, result, calibration, calibrationFileName, levelling } = state;

  return (
    <div className="lab-panel">
      <h2 className="lab-panel-title">Observation</h2>
      {status === "idle" && (
        <>
          <p className="lab-panel-note">
            Every frame is seeked to and detected in order, so nothing is skipped
            — which is slower than playback and the reason a gap downstream means
            the detector lost the golfer rather than that we outran it.
          </p>
          {/*
            A standing shot can be loaded FIRST, and when it is there is
            no swing and no result to hang its verdict off. Showing it
            here is the difference between "measured, waiting for a
            swing" and the user believing nothing happened.
          */}
          {calibration && (
            <StandingShotReadout calibration={calibration} fileName={calibrationFileName} />
          )}
        </>
      )}
      {status === "running" && progress && (
        <>
          <dl className="lab-readout">
            <div className="lab-readout-row">
              <dt>Detecting</dt>
              <dd>{progress.phase === "standing" ? "standing shot" : "the swing"}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Frame</dt>
              <dd>
                {progress.index} / {progress.total}
              </dd>
            </div>
            <div className="lab-readout-row">
              <dt>Detected</dt>
              <dd>{progress.detected}</dd>
            </div>
          </dl>
          <span className="lab-bar" aria-hidden="true">
            <span
              className="lab-bar-fill"
              style={{
                width: `${
                  progress.total > 0 ? Math.round((progress.index / progress.total) * 100) : 0
                }%`,
              }}
            />
          </span>
        </>
      )}
      {status === "error" && <p className="lab-panel-error">{error}</p>}
      {status === "ready" && result && (
        <>
          <dl className="lab-readout">
            <div className="lab-readout-row">
              <dt>Detector</dt>
              <dd>{result.camera.detector}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Frames</dt>
              <dd>{result.camera.frames.length}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Measured fps</dt>
              <dd>{result.info.fps}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Undetected</dt>
              <dd>{result.undetectedFrames}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Duplicate decodes</dt>
              <dd>{result.duplicateDecodes}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Clubhead found in</dt>
              <dd>
                {result.clubDetections} / {result.camera.frames.length}
              </dd>
            </div>
            <div className="lab-readout-row">
              <dt>Anchor frame</dt>
              <dd>{result.world.anchor.anchorFrameIndex}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Anchor stable</dt>
              <dd>{result.world.anchor.anchorIsStable ? "yes" : "no"}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Stance width</dt>
              <dd>{result.world.anchor.stanceWidthM.toFixed(3)} m</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Standing shot</dt>
              <dd>
                {!calibration
                  ? "none"
                  : calibration.usable
                    ? `${calibration.pitchDeg >= 0 ? "+" : ""}${calibration.pitchDeg.toFixed(2)}° pitch`
                    : "refused"}
              </dd>
            </div>
            <div className="lab-readout-row">
              <dt>Camera roll</dt>
              <dd>
                {result.world.anchor.gravityTiltIsMeasured
                  ? `${result.world.anchor.gravityTiltDeg.toFixed(2)}°`
                  : "not measured"}
              </dd>
            </div>
            <div className="lab-readout-row">
              <dt>Took</dt>
              <dd>{(result.elapsedMs / 1000).toFixed(1)} s</dd>
            </div>
          </dl>
          {calibration && !calibration.usable && (
            <p className="lab-panel-note">
              Standing shot refused: {calibration.reason}. The world is levelled
              from what the swing can prove on its own instead, which is a lower
              bound rather than a measurement.
            </p>
          )}
          {levelling?.agreement === "boundary-forced-more" && (
            <p className="lab-panel-note">
              The standing shot and the swing disagree. The shot asked for{" "}
              {calibration?.pitchDeg.toFixed(2)}°, but the swing still put the
              golfer&rsquo;s mass outside their feet, so a further{" "}
              {levelling.boundaryResidualDeg.toFixed(2)}° was forced on top.
              Physics wins that argument — but the usual cause is the two clips
              being filmed from different places, which no correction can undo.
            </p>
          )}
          {levelling?.source === "standing-shot" &&
            levelling.agreement === "agree" &&
            !levelling.calibrationWithinBoundary && (
              <p className="lab-panel-note">
                The standing shot claims a pitch the swing says is impossible.
                Treat this reconstruction as unreliable and check that both clips
                came from the same camera position.
              </p>
            )}
          {!result.world.anchor.gravityTiltIsMeasured && (
            <p className="lab-panel-note">
              No frame had the golfer standing on both feet, so there was no
              horizontal line to measure against. This world is level only
              because nothing was done to it — which is not the same as a camera
              that was level.
            </p>
          )}
          {!result.world.anchor.anchorIsStable && (
            <p className="lab-panel-note">
              No still frame with both feet visible was found, so the world axes
              are a best guess and every coordinate inherits that doubt.
            </p>
          )}
          <label className="lab-toggle">
            <input
              type="checkbox"
              checked={showLowConfidence}
              onChange={(event) => onShowLowConfidence(event.target.checked)}
            />
            <span>Overlay: show low-confidence landmarks</span>
          </label>
          <label className="lab-toggle">
            <input
              type="checkbox"
              checked={useMotionLayer}
              onChange={(event) => onUseMotionLayer(event.target.checked)}
            />
            <span>Reconstruct (Motion Layer)</span>
          </label>
        </>
      )}
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
      <dl className="lab-readout">
        <div className="lab-readout-row">
          <dt>Standing shot</dt>
          <dd>{fileName ?? "loaded"}</dd>
        </div>
        <div className="lab-readout-row">
          <dt>Camera pitch</dt>
          <dd>
            {calibration.usable
              ? `${calibration.pitchDeg >= 0 ? "+" : ""}${calibration.pitchDeg.toFixed(2)}°`
              : "refused"}
          </dd>
        </div>
        <div className="lab-readout-row">
          <dt>Range</dt>
          <dd>
            {calibration.pitchRangeDeg[0].toFixed(2)}° … {calibration.pitchRangeDeg[1].toFixed(2)}°
          </dd>
        </div>
        <div className="lab-readout-row">
          <dt>Stood off plumb by</dt>
          <dd>{(calibration.standingBendM * 1000).toFixed(0)} mm</dd>
        </div>
        <div className="lab-readout-row">
          <dt>Still frames used</dt>
          <dd>{calibration.samples}</dd>
        </div>
      </dl>
      <p className="lab-panel-note">
        {calibration.usable
          ? "Measured. Load a swing filmed from the same camera position and it will be levelled with this rather than with the lower bound the swing can prove on its own."
          : `Refused: ${calibration.reason}.`}
      </p>
    </>
  );
}
