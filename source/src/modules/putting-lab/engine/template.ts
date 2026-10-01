// The printed A3 calibration template and the detector that finds it.
//
// Coordinates are millimetres with the ball centre at the origin, +y down the
// target line and +x to its right: the world frame the lab measures in. The
// printable sheet (public/putting-lab/calibration-template-a3.svg) is drawn
// from the same layout; template.test.ts checks the two agree.
//
// Six small black dots and one larger aim dot give the solve redundancy and
// direction. A solid black disc where the ball goes is an eighth reference
// before the ball is placed, and afterwards a dark ground for a white ball.
// The sheet is left-right symmetric, so it cannot detect a mirrored image; a
// rear camera never mirrors.

import { BlobDetector, refineSpot, type Blob } from "./blobs";
import { homographyRMS, solveHomography, Vec2, type Mat3 } from "./geometry";
import { bounds, type LumaPlane } from "./luma";

export const BALL_DIAMETER_MM = 42.67;
export const BALL_RADIUS_MM = BALL_DIAMETER_MM / 2;

export type TemplateReference = { kind: "dot" | "aimDot" | "ballDisc"; position: Vec2; radius: number };

export const TEMPLATE = {
  references: [
    { kind: "ballDisc", position: new Vec2(0, 0), radius: 28 },
    { kind: "aimDot", position: new Vec2(0, 195), radius: 12 },
    ...[
      [-110, -165],
      [110, -165],
      [-110, 60],
      [110, 60],
      [-110, 195],
      [110, 195],
    ].map(([x, y]) => ({ kind: "dot" as const, position: new Vec2(x, y), radius: 8 })),
  ] as TemplateReference[],
  /** The putter face sits this far behind the ball centre at calibration. */
  faceLineY: -BALL_RADIUS_MM,
  faceLineHalfLength: 80,
  sheetMin: new Vec2(-148.5, -195),
  sheetMax: new Vec2(148.5, 225),
};

/** The validation fan through the face centre, degrees (positive = face open/right). */
export const VALIDATION_FACE_ANGLES = [-2, -1, 1, 2];

const ballDisc = TEMPLATE.references.find((r) => r.kind === "ballDisc")!;
const aimDot = TEMPLATE.references.find((r) => r.kind === "aimDot")!;
const dots = TEMPLATE.references.filter((r) => r.kind === "dot");
export const TEMPLATE_DISC_RADIUS = ballDisc.radius;

export type TemplateDetection = {
  /** Matched references, image pixels and template millimetres, in the same order. */
  imagePoints: Vec2[];
  worldPoints: Vec2[];
  imageToWorld: Mat3;
  rmsMM: number;
};

function minimumSpacing() {
  const pts = TEMPLATE.references.map((r) => r.position);
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.min(m, pts[i].distance(pts[j]));
  return m;
}

/**
 * Finds the template by shape and relative size: the ball disc and the aim
 * dot predict where every other dot must be, and only a sighting with every
 * reference where it should be is accepted. The template's geometry is the model.
 */
export class TemplateDetector {
  imageIsMirrored = false;
  maxRMSMM = 2;
  private blobs = new BlobDetector();

  detect(plane: LumaPlane): TemplateDetection | null {
    const step = plane.width >= 1000 ? 2 : 1;
    const window = Math.max(48, Math.floor(plane.width / 6));
    const found = this.blobs.detect(plane, bounds(plane), { kind: "adaptiveDark", window, offset: 30 }, step, 4);
    const candidates = found.filter((b) => !b.touchesEdge && b.fillRatio > 0.55 && b.fillRatio < 0.95 && b.elongation < 1.8);
    if (candidates.length < TEMPLATE.references.length) return null;

    const aimSpan = aimDot.position.distance(ballDisc.position);
    const expectedDiscRatio = (ballDisc.radius / aimDot.radius) ** 2;
    const expectedDotRatio = (dots[0].radius / aimDot.radius) ** 2;
    const tolerance0 = 0.3 * minimumSpacing();
    const world = [ballDisc.position, aimDot.position, ...dots.map((d) => d.position)];
    const flip = this.imageIsMirrored ? 1 : -1;

    let best: { indices: number[]; rms: number } | null = null;
    const byArea = candidates.map((_, i) => i).sort((a, b) => candidates[b].area - candidates[a].area);
    for (const di of byArea.slice(0, 6)) {
      for (const ai of byArea) {
        if (ai === di) continue;
        const ratio = candidates[di].area / candidates[ai].area;
        if (ratio <= expectedDiscRatio * 0.45 || ratio >= expectedDiscRatio * 2.2) continue;
        const d = candidates[di].centroid;
        const a = candidates[ai].centroid;
        const s = d.distance(a) / aimSpan;
        if (s <= 0) continue;
        // Image y runs down, template y toward the target: a camera looking
        // down sees the template reflected in y.
        const anchor = aimDot.position.sub(ballDisc.position);
        const imageDir = a.sub(d);
        const phi = Math.atan2(imageDir.y, imageDir.x) - Math.atan2(anchor.y * flip, anchor.x);
        const predict = (p: Vec2) => d.add(new Vec2(p.x, p.y * flip).rotated(phi).mul(s));

        const indices = [di, ai];
        const used = new Set(indices);
        const tolerance = tolerance0 * s;
        for (const dot of dots) {
          const q = predict(dot.position);
          let pick = -1;
          let pickDistance = tolerance;
          candidates.forEach((c, ci) => {
            if (used.has(ci)) return;
            const r = c.area / candidates[ai].area;
            if (r <= expectedDotRatio * 0.4 || r >= expectedDotRatio * 2) return;
            const dist = c.centroid.distance(q);
            if (dist < pickDistance) {
              pickDistance = dist;
              pick = ci;
            }
          });
          if (pick < 0) break;
          indices.push(pick);
          used.add(pick);
        }
        if (indices.length !== TEMPLATE.references.length) continue;
        const image = indices.map((i) => refineSpot(plane, candidates[i], true));
        const h = solveHomography(image, world);
        if (!h) continue;
        const rms = homographyRMS(h, image, world);
        if (rms < (best?.rms ?? Infinity)) best = { indices, rms };
      }
    }
    if (!best || best.rms > this.maxRMSMM) return null;
    const image = best.indices.map((i) => refineSpot(plane, candidates[i] as Blob, true));
    const h = solveHomography(image, world);
    if (!h) return null;
    return { imagePoints: image, worldPoints: world, imageToWorld: h, rmsMM: best.rms };
  }
}
