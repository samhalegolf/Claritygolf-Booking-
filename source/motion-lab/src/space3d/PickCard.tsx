/**
 * What a mark in the 3D Space is, and where it came from.
 *
 * Everything drawn in the Space is a Motion Layer output, so every card can
 * say how much reconstruction is behind the mark: a joint's provenance and
 * how far it was moved from the raw observation, the club's evidence, the
 * mass model's confidence. The card follows the playhead, so scrubbing with
 * it open shows the numbers change.
 */

import type { ClarityFrame, ClaritySequence, JointContext, Vec3 } from "../contracts";
import type { ScenePick } from "./ClarityScene";
import { PROVENANCE_LABELS } from "./palette";

const mm = (metres: number) => `${(metres * 1000).toFixed(0)}mm`;
const pct = (unit: number) => `${(unit * 100).toFixed(0)}%`;
const at = (position: Vec3) =>
  `${position[0].toFixed(2)}, ${position[1].toFixed(2)}, ${position[2].toFixed(2)} m`;

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="lab-pick-row">
    <span>{label}</span>
    <span>{value}</span>
  </div>
);

/**
 * What the detector's own confidence in this joint means, in words. There is
 * only ever one such number -- visibility -- and it says the body part is in
 * the picture, not that the point landed in the right place on it. So this
 * reads it as a floor on usability and leaves the question of correctness to
 * provenance, which records what the body made of it.
 */
const detectorVerdict = (rawConfidence: number, source: keyof typeof PROVENANCE_LABELS): string => {
  if (source === "derived") {
    return "too weak to use — the position comes from the body's geometry instead";
  }
  if (source === "reconstructed" || source === "extrapolated" || source === "missing") {
    return "nothing usable this frame — the detector's reading was under Clarity's floor or absent";
  }
  if (rawConfidence >= 0.5) return "seen in the image";
  return "not confident it could see this — the reading is an inference, used at low trust";
};

const describeSource = (source: keyof typeof PROVENANCE_LABELS): string => {
  switch (source) {
    case "observed":
      return "Where the detector put it, kept.";
    case "anchored":
      return "Held at its address stance by the foot leash. The detector's reading was set aside until the knee proves the foot moved.";
    case "constrained":
      return "Seen, but moved to keep the body coherent — bone length, a jump repair, or a foot released onto its arc.";
    case "derived":
      return "Not seen well enough to use. Placed from the near hand and the grip this clip taught, on bones this clip measured — anatomy, not a guess through time.";
    case "reconstructed":
      return "Not seen on this frame. Rebuilt from observations either side of a gap.";
    case "extrapolated":
      return "Not seen, and nothing after it to close the gap. A forward guess.";
    case "missing":
      return "Not seen and not recoverable. Drawn small so the absence is visible.";
  }
};

/**
 * The context bids on a joint, in words: how good a witness the detector was
 * from where the camera stood. Neither says where the joint is -- only how
 * hard it held its ground when the bones disagreed with it.
 */
const contextRows = (context: JointContext): { label: string; value: string }[] => {
  const sight =
    context.depthDoubt > 1.05
      ? `depth ${Math.sqrt(context.depthDoubt).toFixed(1)}× noisier than the picture — bone fixes move it toward or away from the lens first`
      : "depth as good as the picture";

  let hidden = "in plain view";
  if (context.hidden > 0.05) {
    const behind = `${pct(context.hidden)} behind the ${context.hiddenBy}`;
    hidden =
      context.hiddenTrust < 0.995
        ? `${behind} — trust ×${context.hiddenTrust.toFixed(2)}, gives way to its neighbours`
        : `${behind} — not charged, hidden joints were no noisier on this clip`;
  }

  return [
    { label: "Line of sight", value: sight },
    { label: "Hidden", value: hidden },
  ];
};

export function PickCard({
  pick,
  frame,
  sequence,
  onClose,
}: {
  pick: ScenePick;
  frame: ClarityFrame;
  sequence: ClaritySequence;
  onClose: () => void;
}) {
  let title = "";
  let rows: { label: string; value: string }[] = [];
  let note = "";

  switch (pick.kind) {
    case "joint": {
      const provenance = frame.provenance.joints[pick.joint];
      title = pick.joint.replace(/([A-Z])/g, " $1").toLowerCase();
      rows = [
        { label: "Provenance", value: PROVENANCE_LABELS[provenance.source] },
        { label: "Moved from raw", value: mm(provenance.correctionM) },
        { label: "Detector confidence", value: pct(provenance.rawConfidence) },
        { label: "Detector", value: detectorVerdict(provenance.rawConfidence, provenance.source) },
        { label: "Frames since seen", value: String(provenance.framesSinceObserved) },
        ...(provenance.context ? contextRows(provenance.context) : []),
        { label: "Position", value: at(frame.body.joints[pick.joint]) },
      ];
      note = describeSource(provenance.source);
      break;
    }
    case "clubHead": {
      const club = frame.club;
      title = "clubhead";
      rows = club
        ? [
            { label: "Head seen this frame", value: club.evidence.headObserved ? "yes" : "no" },
            { label: "Frames since head seen", value: String(club.evidence.framesSinceHeadObserved) },
            { label: "Club confidence", value: pct(club.confidence) },
            { label: "Position", value: at(club.head) },
          ]
        : [];
      note = "Kinematic club, hung off the reconstructed hands and the image detection of the head. Beta.";
      break;
    }
    case "cbp": {
      const club = frame.club;
      title = "club balance point";
      rows = club
        ? [
            { label: "Shaft length", value: mm(club.lengthM) },
            { label: "Grip from hands", value: club.evidence.gripFromHands ? "yes" : "no" },
            { label: "Club confidence", value: pct(club.confidence) },
            { label: "Position", value: at(club.cbp) },
          ]
        : [];
      note = "Derived along the reconstructed shaft. Not a detected clubhead centre.";
      break;
    }
    case "upperMass":
    case "upperMassGround": {
      const mass = frame.mass;
      title = pick.kind === "upperMass" ? "upper mass centre" : "upper mass, on the ground";
      rows = mass
        ? [
            { label: "Mass confidence", value: pct(mass.confidence) },
            { label: "Position", value: at(pick.kind === "upperMass" ? mass.upperMassCentre : mass.upperMassGround) },
          ]
        : [];
      note = "Mass from the hip joints up, from population segment masses on this golfer's measured bones. An estimate from video.";
      break;
    }
    case "support": {
      const mass = frame.mass;
      title = "estimated support";
      rows = mass
        ? [
            { label: "Lead / trail load", value: `${pct(mass.footShare.left)} / ${pct(mass.footShare.right)}` },
            { label: "Along the stance", value: mass.normalisedSeparation.toFixed(2) },
            { label: "Mass confidence", value: pct(mass.confidence) },
            { label: "Position", value: at(mass.supportCentre) },
          ]
        : [];
      note = "Where the mass sits between the feet. An estimate from video, not force-plate data.";
      break;
    }
    case "ball":
      title = "ball";
      note = "Where the ball was placed, for reference. Not detected.";
      break;
  }

  return (
    <div className="lab-pick-card">
      <div className="lab-pick-card-head">
        <strong>{title}</strong>
        <button type="button" className="lab-pick-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {rows.map((row) => (
        <Row key={row.label} label={row.label} value={row.value} />
      ))}
      {rows.length === 0 && pick.kind !== "ball" && (
        <p className="lab-panel-note">Nothing estimated on this frame.</p>
      )}
      <p className="lab-panel-note">{note}</p>
      <p className="lab-panel-note">
        Frame {frame.index} · overall confidence {pct(frame.confidence.overall)} ·{" "}
        {sequence.source}
      </p>
    </div>
  );
}
