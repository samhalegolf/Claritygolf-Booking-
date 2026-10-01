// The printed A3 calibration template and the detector that finds it.
//
// Coordinates are millimetres with the ball centre at the origin, +y down the
// target line and +x to its right: the world frame the lab measures in. The
// printable sheet (public/putting-lab/calibration-template-a3.svg) is drawn
// from the same layout by templateSVG(); engine.test.ts keeps the two equal.
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

/**
 * The printable sheet as SVG at 1:1 millimetres (public/putting-lab/
 * calibration-template-a3.svg is this, committed; engine.test.ts keeps them
 * equal). Print at 100% ("actual size"), never "fit to page", and check the
 * scale bar. Angles do not depend on print scale; the ball's measured
 * diameter catches a badly scaled print.
 */
export function templateSVG() {
  const { sheetMin, sheetMax, faceLineY, faceLineHalfLength } = TEMPLATE;
  const w = sheetMax.x - sheetMin.x;
  const h = sheetMax.y - sheetMin.y;
  // SVG y runs down the page; template +y (target) runs up it.
  const px = (p: Vec2): [number, number] => [p.x - sheetMin.x, sheetMax.y - p.y];
  const f = (v: number) => v.toFixed(2);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">\n`;
  s += `<rect x="0" y="0" width="${f(w)}" height="${f(h)}" fill="#ffffff"/>\n`;
  const line = (a: Vec2, b: Vec2, colour: string, width: number, dash?: string) => {
    const [x1, y1] = px(a);
    const [x2, y2] = px(b);
    const d = dash ? ` stroke-dasharray="${dash}"` : "";
    s += `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${colour}" stroke-width="${f(width)}"${d}/>\n`;
  };
  // Keep printed lines well clear of the dots: a line touching a dot would merge with it.
  const gap = 8;
  // Target line: from the ball disc to short of the aim dot.
  line(new Vec2(0, ballDisc.radius + gap), new Vec2(0, aimDot.position.y - aimDot.radius - gap), "#9a9a9a", 0.6);
  // Square line for the putter face.
  line(new Vec2(-faceLineHalfLength, faceLineY), new Vec2(-ballDisc.radius - 2, faceLineY), "#8a8a8a", 0.5);
  line(new Vec2(ballDisc.radius + 2, faceLineY), new Vec2(faceLineHalfLength, faceLineY), "#8a8a8a", 0.5);
  // Validation fan: a face turned right (open) by a has its line rotated clockwise by a.
  for (const deg of VALIDATION_FACE_ANGLES) {
    const dir = new Vec2(1, 0).rotated(-(deg * Math.PI) / 180);
    const c = new Vec2(0, faceLineY);
    line(c.add(dir.mul(ballDisc.radius + 6)), c.add(dir.mul(faceLineHalfLength)), "#c4c4c4", 0.35, "2 1.5");
    line(c.sub(dir.mul(ballDisc.radius + 6)), c.sub(dir.mul(faceLineHalfLength)), "#c4c4c4", 0.35, "2 1.5");
    const [lx, ly] = px(c.add(dir.mul(faceLineHalfLength + 6)));
    s += `<text x="${f(lx)}" y="${f(ly)}" font-family="Helvetica" font-size="3" fill="#9a9a9a" text-anchor="middle">${deg > 0 ? "+" : ""}${deg}°</text>\n`;
  }
  for (const r of TEMPLATE.references) {
    const [cx, cy] = px(r.position);
    s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r.radius)}" fill="#000000"/>\n`;
  }
  // Ball outline guide inside the disc (white, so it never joins the disc's outline).
  const [bx, by] = px(Vec2.zero);
  s += `<circle cx="${f(bx)}" cy="${f(by)}" r="${f(BALL_RADIUS_MM)}" fill="none" stroke="#ffffff" stroke-width="0.3" stroke-dasharray="1.5 1.5"/>\n`;
  // Scale bar: 100 mm, bottom left.
  const sb0 = new Vec2(sheetMin.x + 15, sheetMin.y + 12);
  line(sb0, sb0.add(new Vec2(100, 0)), "#6a6a6a", 0.5);
  line(sb0.add(new Vec2(0, -2)), sb0.add(new Vec2(0, 2)), "#6a6a6a", 0.5);
  line(sb0.add(new Vec2(100, -2)), sb0.add(new Vec2(100, 2)), "#6a6a6a", 0.5);
  const [tx, ty] = px(sb0.add(new Vec2(50, 4)));
  s += `<text x="${f(tx)}" y="${f(ty)}" font-family="Helvetica" font-size="3.5" fill="#6a6a6a" text-anchor="middle">100 mm: print at actual size and check this bar</text>\n`;
  const [hx, hy] = px(new Vec2(0, sheetMax.y - 10));
  s += `<text x="${f(hx)}" y="${f(hy)}" font-family="Helvetica" font-size="4" fill="#6a6a6a" text-anchor="middle">Clarity Putting Lab calibration: target this way</text>\n`;
  s += "</svg>\n";
  return s;
}
