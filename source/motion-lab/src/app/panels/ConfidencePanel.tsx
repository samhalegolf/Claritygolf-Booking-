/**
 * The confidence readout.
 *
 * Laid out to match the plan's worked example, because the point of the first
 * version is to LOOK at these numbers across many real swings and work out
 * what useful ranges are. Nothing here says whether a score is good. No colour
 * scale runs from red to green, no threshold is drawn, and the word "poor"
 * does not appear -- all of which would be a guess dressed up as a verdict.
 *
 * The one judgement it does make is structural: the overall score is a BODY
 * score, and the club is listed apart from it. That is not an aesthetic
 * choice, it is the plan's rule that a bad club track must not invalidate a
 * good body reconstruction.
 */

import type { ClarityFrame, ClaritySequence } from "../../contracts";
import { CLARITY_STRUCTURES } from "../../contracts";

const asScore = (unit: number) => Math.round(unit * 100);
const asPercent = (unit: number) => `${Math.round(unit * 100)}%`;

const COMPONENT_ROWS: readonly { key: keyof ClarityFrame["confidence"]["components"]; label: string }[] = [
  { key: "directObservation", label: "Direct observation" },
  { key: "trackingContinuity", label: "Tracking continuity" },
  { key: "jumpCorrection", label: "Jump correction" },
  { key: "gapReconstruction", label: "Gap reconstruction" },
  { key: "bodyConstraintCorrection", label: "Body constraint correction" },
];

export function ConfidencePanel({
  frame,
  sequence,
}: {
  frame: ClarityFrame;
  sequence: ClaritySequence;
}) {
  const { confidence, provenance } = frame;

  return (
    <div className="lab-panel">
      <h2 className="lab-panel-title">Reconstruction confidence</h2>

      <div className="lab-score-headline">
        <span className="lab-score-value">{asScore(confidence.overall)}</span>
        <span className="lab-score-scale">/ 100</span>
      </div>
      <p className="lab-panel-note">
        How much reconstruction this frame needed — not whether the movement looks
        normal. A cleanly observed unusual swing should score high.
      </p>

      <dl className="lab-readout">
        {COMPONENT_ROWS.map(({ key, label }) => (
          <div className="lab-readout-row" key={key}>
            <dt>{label}</dt>
            <dd>{asScore(confidence.components[key])}</dd>
          </div>
        ))}
      </dl>

      <h3 className="lab-panel-subtitle">Club</h3>
      <dl className="lab-readout">
        <div className="lab-readout-row">
          <dt>Club-point confidence</dt>
          <dd>{asScore(confidence.components.clubPoint)}</dd>
        </div>
        {frame.club ? (
          <>
            <div className="lab-readout-row">
              <dt>Head observed</dt>
              <dd>{frame.club.evidence.headObserved ? "yes" : "no"}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Frames since head seen</dt>
              <dd>{frame.club.evidence.framesSinceHeadObserved}</dd>
            </div>
            <div className="lab-readout-row">
              <dt>Measured club</dt>
              <dd>{frame.club.lengthM.toFixed(3)} m</dd>
            </div>
          </>
        ) : (
          <div className="lab-readout-row">
            <dt>Club</dt>
            <dd>no evidence</dd>
          </div>
        )}
      </dl>
      <p className="lab-panel-note">
        The balance point is derived from the club's reconstructed geometry, never
        from the detected clubhead pixels — and the club's length is measured from
        viewing-ray geometry, not assumed. Kept apart from the overall score on
        purpose: a poor club track should not invalidate an otherwise strong body
        reconstruction.
      </p>

      <h3 className="lab-panel-subtitle">This frame</h3>
      <dl className="lab-readout">
        <div className="lab-readout-row">
          <dt>Observed joints</dt>
          <dd>{asPercent(provenance.observedFraction)}</dd>
        </div>
        <div className="lab-readout-row">
          <dt>Whole frame reconstructed</dt>
          <dd>{provenance.wholeFrameReconstructed ? "yes" : "no"}</dd>
        </div>
      </dl>

      <h3 className="lab-panel-subtitle">Across the sequence</h3>
      <dl className="lab-readout">
        <div className="lab-readout-row">
          <dt>Overall</dt>
          <dd>{asScore(sequence.confidence.overall)}</dd>
        </div>
        <div className="lab-readout-row">
          <dt>Reconstructed frames</dt>
          <dd>{asPercent(sequence.confidence.reconstructedFrameFraction)}</dd>
        </div>
        <div className="lab-readout-row">
          <dt>Largest reconstructed gap</dt>
          <dd>{sequence.confidence.largestGapFrames} frames</dd>
        </div>
      </dl>

      <h3 className="lab-panel-subtitle">By structure</h3>
      <dl className="lab-readout">
        {CLARITY_STRUCTURES.map((structure) => (
          <div className="lab-readout-row" key={structure}>
            <dt>{structure}</dt>
            <dd>
              <span className="lab-bar" aria-hidden="true">
                <span
                  className="lab-bar-fill"
                  style={{ width: `${asScore(confidence.structures[structure])}%` }}
                />
              </span>
              {asScore(confidence.structures[structure])}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
