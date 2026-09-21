/**
 * Mass and support readout.
 *
 * The labelling here is load-bearing. This is an estimate from video, and the
 * panel says so in the places a reader would otherwise assume force plates:
 * the separation figure is described as descriptive rather than diagnostic,
 * and the foot load is named an estimate every time it appears.
 */

import type { ClarityFrame } from "../../contracts";

const metres = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} m`;

export function MassPanel({ frame }: { frame: ClarityFrame }) {
  const mass = frame.mass;
  if (!mass) {
    return (
      <div className="panel">
        <h2 className="panel-title">Mass and support</h2>
        <p className="panel-note">
          No mass estimate: the body model is too incomplete to distribute mass over.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2 className="panel-title">Mass and support</h2>

      <h3 className="panel-subtitle">Upper mass map</h3>
      <dl className="readout">
        <div className="readout-row">
          <dt>Centre height</dt>
          <dd>{mass.upperMassCentre[1].toFixed(3)} m</dd>
        </div>
        <div className="readout-row">
          <dt>Ground projection X</dt>
          <dd>{metres(mass.upperMassGround[0])}</dd>
        </div>
        <div className="readout-row">
          <dt>Ground projection Z</dt>
          <dd>{metres(mass.upperMassGround[2])}</dd>
        </div>
      </dl>
      <p className="panel-note">
        Mass from the hip joints up, projected straight down. It is not constrained
        to land under either foot, and often does not.
      </p>

      <h3 className="panel-subtitle">Estimated support</h3>
      <dl className="readout">
        <div className="readout-row">
          <dt>Centre X</dt>
          <dd>{metres(mass.supportCentre[0])}</dd>
        </div>
        <div className="readout-row">
          <dt>Contact points</dt>
          <dd>{mass.supportPolygon.length === 0 ? "none" : mass.supportPolygon.length}</dd>
        </div>
        <div className="readout-row">
          <dt>Lead foot</dt>
          <dd>{Math.round(mass.footShare.left * 100)}%</dd>
        </div>
        <div className="readout-row">
          <dt>Trail foot</dt>
          <dd>{Math.round(mass.footShare.right * 100)}%</dd>
        </div>
        <div className="readout-row">
          <dt>Confidence</dt>
          <dd>{Math.round(mass.confidence * 100)}</dd>
        </div>
      </dl>
      <p className="panel-note">
        Estimated foot load from video, not force-plate data. No pressure is
        measured and no rotational force is modelled. With no foot in contact the
        confidence is zero and the even split above is the absence of a claim.
      </p>

      <h3 className="panel-subtitle">Mass–support relationship</h3>
      <dl className="readout">
        <div className="readout-row">
          <dt>Normalised separation</dt>
          <dd>{mass.normalisedSeparation.toFixed(3)}</dd>
        </div>
      </dl>
      <p className="panel-note">
        Upper mass ground position minus support centre, along the stance line,
        divided by stance width. Positive is toward the trail foot. An experimental
        descriptive signal — no biomechanical meaning is assigned to any value.
      </p>
    </div>
  );
}
