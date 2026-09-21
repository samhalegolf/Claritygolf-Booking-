/**
 * Mass and support readout.
 *
 * The labelling here is load-bearing. This is an estimate from video, and the
 * panel says so in the places a reader would otherwise assume force plates:
 * the separation figure is described as descriptive rather than diagnostic,
 * and the foot load is named an estimate every time it appears.
 */

import type { ClarityFrame, ClaritySequence, MassSanity } from "../../contracts";

const metres = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)} m`;
/** Heel is 0, toe is 1. Shown as a percentage because the foot is the ruler. */
const alongFoot = (value: number) => `${(value * 100).toFixed(0)}% of foot`;
const degrees = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}°`;

export function MassPanel({
  frame,
  sequence,
}: {
  frame: ClarityFrame;
  sequence: ClaritySequence;
}) {
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

      <ForeAftCheck sanity={sequence.massSanity} />
    </div>
  );
}

/**
 * Whether the fore-aft mass reading is physically possible.
 *
 * This is the panel's only section about the CAMERA rather than the golfer,
 * and it earns its place because the fore-aft reading is the one number here
 * that a tilted tripod can move further than the golfer can. Sixteen
 * millimetres per degree, on a foot about 265mm long.
 *
 * Nothing above has been corrected for it. The readout says what the physics
 * implies; applying it is a separate decision, not taken in the pipeline.
 */
function ForeAftCheck({ sanity }: { sanity: MassSanity | null }) {
  if (!sanity || sanity.verdict === "undetermined") {
    return (
      <>
        <h3 className="panel-subtitle">Heel–toe reading</h3>
        <p className="panel-note">
          Not checked: no frame in this clip had the golfer standing on two feet
          the detector could actually see. That is not the same as the reading
          being sound — there was simply nothing to check it against.
        </p>
      </>
    );
  }

  const [low, high] = sanity.pitchRangeDeg;

  return (
    <>
      <h3 className="panel-subtitle">Heel–toe reading</h3>
      <dl className="readout">
        <div className="readout-row">
          <dt>Mass along foot</dt>
          <dd>{alongFoot(sanity.reading.footFractionUnit)}</dd>
        </div>
        <div className="readout-row">
          <dt>From body shape alone</dt>
          <dd>{alongFoot(sanity.reading.bendFractionUnit)}</dd>
        </div>
        <div className="readout-row">
          <dt>Camera pitch consistent with</dt>
          <dd>
            {degrees(low)} … {degrees(high)}
          </dd>
        </div>
        <div className="readout-row">
          <dt>Least pitch that fits</dt>
          <dd>{degrees(sanity.minimumPitchDeg)}</dd>
        </div>
        {sanity.impossibleFrames > 0 && (
          <div className="readout-row">
            <dt>Outside the feet</dt>
            <dd>
              {sanity.impossibleFrames} / {sanity.samples} frames
            </dd>
          </div>
        )}
        <div className="readout-row">
          <dt>Confidence</dt>
          <dd>{Math.round(sanity.confidence * 100)}</dd>
        </div>
      </dl>

      {sanity.verdict === "corrected" && (
        <p className="panel-note">
          The mass read outside the feet, which a golfer standing on both of them
          cannot do. The least camera pitch explaining that is{" "}
          {degrees(sanity.minimumPitchDeg)}, which would put the reading at{" "}
          {alongFoot(sanity.correctedFootFractionUnit)}.{" "}
          <strong>Nothing above has been corrected.</strong> The true pitch is at
          least this much and may be more — the reading only has to get back
          inside the foot to stop being impossible, not back to where it was.
        </p>
      )}

      {sanity.verdict === "consistent" && (
        <p className="panel-note">
          The mass stayed over the feet throughout, so no camera pitch is forced
          by the physics. That is not a level camera — anything in the range above
          would also fit. A clip whose mass never approaches the edge of the foot
          cannot pin the camera down, and the confidence reflects how wide that
          range is rather than how good the swing was.
        </p>
      )}

      {sanity.verdict === "irreconcilable" && (
        <p className="panel-note">
          No single camera pitch makes every frame possible, so the disagreement
          is not the camera. Either the feet moved during the frames treated as a
          stance, or the detector placed the body badly in some of them.
        </p>
      )}

      <p className="panel-note">
        &ldquo;From body shape alone&rdquo; is the part of the reading a camera
        angle cannot invent: the bend in the body, with any whole-body lean
        removed along with the tilt. Across this clip the bend moved the mass{" "}
        {(sanity.bendRangeM * 1000).toFixed(0)}mm and the lean moved it{" "}
        {(sanity.leanRangeM * 1000).toFixed(0)}mm — both immune to the camera,
        because a constant pitch cancels out of a difference.
      </p>
    </>
  );
}
