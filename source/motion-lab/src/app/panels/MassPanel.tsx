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

      <ForeAftCheck
        sanity={sequence.massSanity}
        appliedDeg={sequence.anchor.pitchCorrectionDeg}
        appliedFrom={sequence.anchor.pitchCorrectionSource}
      />
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
function ForeAftCheck({
  sanity,
  appliedDeg,
  appliedFrom,
}: {
  sanity: MassSanity | null;
  /**
   * The pitch already taken out of these coordinates, from the anchor.
   *
   * Separate from anything in `sanity`, and necessarily so: the check below
   * ran on the CORRECTED scene, so it reports what is still forced, which
   * after a correction is nothing. Without this the readout would say the
   * clip was fine and never mention that it had been rotated to get there.
   */
  appliedDeg: number;
  /**
   * Where that pitch came from. A bound and an estimate are different claims
   * and the readout should not let them look alike.
   */
  appliedFrom: ClaritySequence["anchor"]["pitchCorrectionSource"];
}) {
  if (!sanity || sanity.verdict === "undetermined") {
    return (
      <>
        <h3 className="panel-subtitle">Heel–toe reading</h3>
        <p className="panel-note">
          Not checked against the falling-over boundary: no frame in this clip
          had the golfer standing on two feet the detector could actually see. That is not the same as the reading
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
        {Math.abs(appliedDeg) > 0.05 && (
          <div className="readout-row">
            <dt>World pitched by</dt>
            <dd>
              {degrees(appliedDeg)}
              {appliedFrom === "standing-shot" ? " · standing shot" : " · boundary"}
            </dd>
          </div>
        )}
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
          <dd>{degrees(sanity.fallingOverPitchDeg)}</dd>
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
          <dt>Detector foot</dt>
          <dd>{(sanity.reading.footScaleUnit * 100).toFixed(0)}% of anatomy</dd>
        </div>
        <div className="readout-row">
          <dt>Confidence</dt>
          <dd>{Math.round(sanity.confidence * 100)}</dd>
        </div>
      </dl>

      {sanity.reading.footScaleUnit < 0.75 && (
        <p className="panel-note">
          The detector&rsquo;s feet measure{" "}
          {(sanity.reading.footScaleUnit * 100).toFixed(0)}% of the length anatomy
          expects, which is why the base of support above is derived from the
          golfer&rsquo;s height rather than measured between the foot landmarks.
          Around half is normal for this detector and is not a fault in the clip:
          it reads much the same face-on and down the line, so it is the
          detector&rsquo;s own body model rather than the camera angle.
        </p>
      )}

      {sanity.verdict === "corrected" && (
        <p className="panel-note">
          The mass still reads outside the falling-over boundary. A further{" "}
          {degrees(sanity.fallingOverPitchDeg)} of camera pitch would bring it to{" "}
          {alongFoot(sanity.correctedFootFractionUnit)}. This scene has not had
          that applied — either the levelling pass was not run, or it was asked
          to report only.
        </p>
      )}

      {sanity.verdict === "consistent" && Math.abs(appliedDeg) > 0.05 && (
        <p className="panel-note">
          {appliedFrom === "standing-shot" ? (
            <>
              The world has been pitched {degrees(appliedDeg)} from a shot of the
              golfer standing still, and every coordinate in this scene is the
              corrected one. A standing body is close to a plumb line, so its
              fore-aft slope is close to the camera&rsquo;s — good to about a
              degree, and only as good as the golfer standing where and how they
              were asked. The mass then falls inside the falling-over boundary
              with nothing further forced, which is the swing independently
              agreeing.
            </>
          ) : (
            <>
              The mass read outside the falling-over boundary — past the toes or
              behind the heels, where the golfer would not have been standing.
              The world has been pitched {degrees(appliedDeg)} to bring it back,
              and every coordinate in this scene is the corrected one.{" "}
              <strong>That is a floor, not a fix.</strong> The camera was tilted
              at least this much and may well be more: the reading only has to
              reach the boundary to stop being impossible, not return to where it
              truly was. A standing shot would pin it down properly.
            </>
          )}
        </p>
      )}

      {sanity.verdict === "consistent" && Math.abs(appliedDeg) <= 0.05 && (
        <p className="panel-note">
          The mass stayed inside the falling-over boundary throughout, so no
          camera pitch is forced and none has been applied. That is not a level
          camera — anything in the range above would also fit. A clip whose mass
          never approaches the edge of the foot cannot pin the camera down, and
          the confidence reflects how wide that range is rather than how good
          the swing was.
        </p>
      )}

      {sanity.verdict === "irreconcilable" && (
        <p className="panel-note">
          No single camera pitch keeps every frame inside the falling-over
          boundary, so the disagreement is not the camera. Either the feet moved during the frames treated as a
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
