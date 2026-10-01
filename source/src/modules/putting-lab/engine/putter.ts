// The putter is never "found" from scratch. At calibration the face sits
// square on the printed line, and that moment teaches the lab how whatever it
// can see on this putter (stickers, texture, the face's top edge) relates to
// the true face. From then on tracking is a rigid-body problem.
//
// LOCAL frame: the world frame at calibration, moved so the face centre is the
// origin. +x along the face, +y the face normal (toward the target). A pose
// carries local -> world. Face angle is the negative of the pose rotation
// (rotation is counter-clockwise, face angle is positive to the right).
//
// Three lightweight witnesses, none of which owns the truth:
//   markers   sticker centroids -> rigid fit. Strongest when present.
//   features  texture on the head, matched against how calibration says it
//             should look at the predicted pose. Rotation and position.
//   edge      the face's top edge across the face, plus the toe end.

import { BlobDetector, refineSpot } from "./blobs";
import type { PuttingCoordinateSystem } from "./coordinates";
import {
  apply3,
  clampUnit,
  fitLine,
  linearSolve,
  mul3,
  radians,
  RigidTransform,
  sum,
  Vec2,
  wrapAngle,
} from "./geometry";
import { bounds, crop, IntRect, pixel, sample, sampleCrop, type LumaCrop, type LumaPlane } from "./luma";
import { TEMPLATE, TEMPLATE_DISC_RADIUS } from "./template";

export type Handedness = "right" | "left";
export type PutterTrackingMode = "markerless" | "enhanced";
export type PutterSource = "markers" | "features" | "edge";

export type PutterFeature = { local: Vec2; calibrationPixel: Vec2 };

export type PutterCalibration = {
  /** Local -> world at calibration: rotation 0, translation = face centre. */
  pose: RigidTransform;
  faceHalfWidth: number;
  /** Where the visible front edge sits along the face normal, local mm. */
  edgeOffset: number;
  /** The visible edge's angle at calibration; the face was square by definition. */
  edgeAngle: number;
  /** Where the toe end of the head shows, local mm (signed). Pins the slide along the face. */
  toeEnd: number | null;
  headLuma: number;
  /** Sticker centres, local mm. Three or more switch on enhanced tracking. */
  markers: Vec2[];
  markerRadiusMM: number;
  markerThreshold: number;
  features: PutterFeature[];
  /** The head as the camera saw it at calibration. */
  reference: LumaCrop | null;
  handedness: Handedness;
  timestamp: number;
};

export const trackingMode = (c: PutterCalibration): PutterTrackingMode => (c.markers.length >= 3 ? "enhanced" : "markerless");
export const toeSign = (c: { handedness: Handedness }) => (c.handedness === "right" ? 1 : -1);

/** Face end points and centre, world mm, for a pose. */
export function faceLine(c: { faceHalfWidth: number; handedness: Handedness }, pose: RigidTransform) {
  const s = toeSign(c);
  return {
    heel: pose.apply(new Vec2(-s * c.faceHalfWidth, 0)),
    center: pose.apply(Vec2.zero),
    toe: pose.apply(new Vec2(s * c.faceHalfWidth, 0)),
  };
}

/** A scalar statement about the face centre: normal . position == value. */
export type PositionConstraint = { normal: Vec2; value: number; sigma: number };

export type PutterObservation = {
  source: PutterSource;
  timestamp: number;
  /** Pose rotation (counter-clockwise radians) and its standard error. */
  rotation: number | null;
  rotationSigma: number;
  constraints: PositionConstraint[];
  /** 0..1: how good a witness this was, this frame. */
  confidence: number;
  /** Image points the source used, for the debug overlay. */
  debugPoints: Vec2[];
};

/** The full pose, when the observation pinned both axes. */
export function observationPose(o: PutterObservation): RigidTransform | null {
  if (o.rotation === null || o.constraints.length < 2) return null;
  const ata = [0, 0, 0, 0];
  const atb = [0, 0];
  for (const c of o.constraints) {
    const w = 1 / (c.sigma * c.sigma);
    ata[0] += w * c.normal.x * c.normal.x;
    ata[1] += w * c.normal.x * c.normal.y;
    ata[2] += w * c.normal.y * c.normal.x;
    ata[3] += w * c.normal.y * c.normal.y;
    atb[0] += w * c.normal.x * c.value;
    atb[1] += w * c.normal.y * c.value;
  }
  const p = linearSolve(ata, atb, 2);
  return p ? new RigidTransform(o.rotation, new Vec2(p[0], p[1])) : null;
}

function fullObservation(
  source: PutterSource,
  t: number,
  pose: RigidTransform,
  rotationSigma: number,
  positionSigma: number,
  confidence: number,
  debug: Vec2[],
): PutterObservation {
  return {
    source,
    timestamp: t,
    rotation: pose.rotation,
    rotationSigma,
    constraints: [
      { normal: new Vec2(1, 0), value: pose.translation.x, sigma: positionSigma },
      { normal: new Vec2(0, 1), value: pose.translation.y, sigma: positionSigma },
    ],
    confidence,
    debugPoints: debug,
  };
}

/** The strongest step along a sampled line (sub-sample index and luma per mm), or null when there is no clear edge. */
function strongestStep(values: number[], step: number): { at: number; strength: number } | null {
  if (values.length < 5) return null;
  let best = 0;
  let bestG = 0;
  for (let i = 1; i < values.length - 1; i++) {
    const g = Math.abs(values[i + 1] - values[i - 1]);
    if (g > bestG) {
      bestG = g;
      best = i;
    }
  }
  // An edge worth fitting: a clear step over about a millimetre.
  if (bestG / (2 * step) <= 8 || best <= 1 || best >= values.length - 2) return null;
  const gm = Math.abs(values[best] - values[best - 2]);
  const gp = Math.abs(values[best + 2] - values[best]);
  const denom = gm - 2 * bestG + gp;
  const frac = Math.abs(denom) > 1e-9 ? (0.5 * (gm - gp)) / denom : 0;
  return { at: best + Math.max(-0.5, Math.min(0.5, frac)), strength: bestG / (2 * step) };
}

// MARK: edge

export type EdgeReading = {
  rotation: number;
  offset: number;
  rms: number;
  used: number;
  tried: number;
  worldPoints: Vec2[];
  imagePoints: Vec2[];
  meanGradient: number;
};

/**
 * Scan across the face along its normal and fit a line to the strongest
 * edges. With `raw` the reading is the edge itself (calibration); otherwise
 * the calibrated edge angle and offset are taken off it.
 */
export function measureEdge(
  plane: LumaPlane,
  c: PuttingCoordinateSystem,
  cal: PutterCalibration,
  pose: RigidTransform,
  searchMM: number,
  columnFilter?: (u: number) => boolean,
  raw = false,
  columns = 15,
): EdgeReading | null {
  const step = Math.max(0.2, c.surface.mmPerPixelAtBall * 0.5);
  const centre = raw ? 0 : cal.edgeOffset;
  const lo = centre - searchMM;
  const hi = centre + searchMM;
  const frame = bounds(plane);
  let world: Vec2[] = [];
  let image: Vec2[] = [];
  let strengths: number[] = [];
  let tried = 0;
  for (let k = 0; k < columns; k++) {
    const u = -cal.faceHalfWidth * 0.8 + (cal.faceHalfWidth * 1.6 * k) / Math.max(1, columns - 1);
    if (columnFilter && !columnFilter(u)) continue;
    tried++;
    // One step beyond each end so the central difference covers the range.
    const values: number[] = [];
    for (let v = lo - step; v <= hi + step * 1.01; v += step) {
      const p = c.imageFromWorld(pose.apply(new Vec2(u, v)));
      if (!p || !frame.contains(p)) break;
      values.push(sample(plane, p));
    }
    const found = strongestStep(values, step);
    if (!found) continue;
    const w = pose.apply(new Vec2(u, lo - step + found.at * step));
    world.push(w);
    image.push(c.imageFromWorld(w) ?? Vec2.zero);
    strengths.push(found.strength);
  }
  if (world.length < 4) return null;
  const along = pose.applyToVector(new Vec2(1, 0));
  let fit = fitLine(world, strengths, along);
  if (!fit) return null;
  // One pass of outlier rejection: a scan that caught the shaft or the ball's far side.
  const normal0 = new Vec2(-fit.direction.y, fit.direction.x);
  const residuals = world.map((p) => Math.abs(p.sub(fit!.point).dot(normal0)));
  const median = [...residuals].sort((a, b) => a - b)[Math.floor(residuals.length / 2)];
  const keep = residuals.map((_, i) => i).filter((i) => residuals[i] <= Math.max(0.6, 3 * median));
  if (keep.length >= 4 && keep.length < world.length) {
    const refit = fitLine(keep.map((i) => world[i]), keep.map((i) => strengths[i]), along);
    if (refit) {
      fit = refit;
      world = keep.map((i) => world[i]);
      image = keep.map((i) => image[i]);
      strengths = keep.map((i) => strengths[i]);
    }
  }
  const edgeRotation = Math.atan2(fit.direction.y, fit.direction.x);
  const n = new Vec2(-fit.direction.y, fit.direction.x);
  return {
    rotation: raw ? edgeRotation : wrapAngle(edgeRotation - cal.edgeAngle),
    offset: fit.point.sub(pose.translation).dot(n),
    rms: fit.rms,
    used: world.length,
    tried,
    worldPoints: world,
    imagePoints: image,
    meanGradient: strengths.reduce((a, b) => a + b, 0) / strengths.length,
  };
}

/**
 * Where the toe actually ends (local mm along the face), from several scan
 * lines at different depths behind the edge: one line's end moves in
 * whole-pixel steps as the head slides.
 */
export function measureToeEnd(plane: LumaPlane, c: PuttingCoordinateSystem, cal: PutterCalibration, pose: RigidTransform, expected: number) {
  const step = Math.max(0.2, c.surface.mmPerPixelAtBall * 0.5);
  const sign = expected >= 0 ? 1 : -1;
  const from = Math.abs(expected) - 15;
  const to = Math.abs(expected) + 15;
  const frame = bounds(plane);
  let ends: number[] = [];
  for (const depth of [3, 6, 9, 12]) {
    const v = cal.edgeOffset - depth;
    const values: number[] = [];
    let inside = true;
    for (let u = from - step; u <= to + step * 1.01; u += step) {
      const p = c.imageFromWorld(pose.apply(new Vec2(sign * u, v)));
      if (!p || !frame.contains(p)) {
        inside = false;
        break;
      }
      values.push(sample(plane, p));
    }
    if (!inside) continue;
    const found = strongestStep(values, step);
    if (found) ends.push(from - step + found.at * step);
  }
  if (ends.length < 2) return null;
  if (ends.length >= 3) {
    const mean = ends.reduce((a, b) => a + b, 0) / ends.length;
    let worst = 0;
    ends.forEach((e, i) => {
      if (Math.abs(e - mean) > Math.abs(ends[worst] - mean)) worst = i;
    });
    ends = ends.filter((_, i) => i !== worst);
  }
  return (sign * ends.reduce((a, b) => a + b, 0)) / ends.length;
}

export function observeEdge(
  plane: LumaPlane,
  c: PuttingCoordinateSystem,
  cal: PutterCalibration,
  predicted: RigidTransform,
  searchMM: number,
  t: number,
): PutterObservation | null {
  const r = measureEdge(plane, c, cal, predicted, searchMM);
  if (!r) return null;
  // The face line is `edgeOffset` behind the edge along the measured normal.
  const n = Vec2.direction(-r.rotation);
  const edgePoint = sum(r.worldPoints).div(r.worldPoints.length);
  const value = n.dot(edgePoint) - cal.edgeOffset;
  const spread = r.worldPoints.reduce((a, p) => a + p.distance(edgePoint), 0) / r.worldPoints.length;
  const posSigma = Math.max(0.15, r.rms / Math.sqrt(r.used));
  const rotSigma = Math.max(radians(0.03), r.rms / (Math.max(5, spread) * Math.sqrt(r.used)));
  const coverage = r.used / Math.max(1, r.tried);
  const crispness = clampUnit(r.rms < 0.3 ? 1 : 0.3 / r.rms);
  const confidence = clampUnit(coverage * 0.6 + crispness * 0.4) * clampUnit(r.meanGradient / 30);
  const constraints: PositionConstraint[] = [{ normal: n, value, sigma: posSigma }];
  const debug = [...r.imagePoints];
  if (cal.toeEnd !== null) {
    const measuredPose = new RigidTransform(r.rotation, predicted.translation);
    const u = measureToeEnd(plane, c, cal, measuredPose, cal.toeEnd);
    if (u !== null) {
      const along = new Vec2(n.y, -n.x); // local +x in world, for this rotation
      const toeWorld = measuredPose.apply(new Vec2(u, cal.edgeOffset));
      constraints.push({ normal: along, value: along.dot(toeWorld) - cal.toeEnd, sigma: 0.3 });
      const p = c.imageFromWorld(toeWorld);
      if (p) debug.push(p);
    }
  }
  return { source: "edge", timestamp: t, rotation: r.rotation, rotationSigma: rotSigma, constraints, confidence, debugPoints: debug };
}

// MARK: features

/**
 * Corners (Shi-Tomasi) inside the head's outline, far enough in that a patch
 * around them is all putter: the background changes when the template is
 * lifted, the putter does not.
 */
export function selectFeatures(
  plane: LumaPlane,
  c: PuttingCoordinateSystem,
  pose: RigidTransform,
  roi: IntRect,
  headLuma: number,
  paper: number,
  halfWidth: number,
  maxCount = 24,
): PutterFeature[] {
  const r = roi.clipped(bounds(plane));
  if (r.width <= 16 || r.height <= 16) return [];
  const headCut = (headLuma + paper) / 2;
  const margin = 7;
  const candidates: Array<{ score: number; x: number; y: number }> = [];
  for (let y = r.minY + margin; y < r.maxY - margin; y++) {
    for (let x = r.minX + margin; x < r.maxX - margin; x++) {
      if (
        pixel(plane, x - margin, y - margin) > headCut ||
        pixel(plane, x + margin, y - margin) > headCut ||
        pixel(plane, x - margin, y + margin) > headCut ||
        pixel(plane, x + margin, y + margin) > headCut
      ) {
        continue;
      }
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const gx = pixel(plane, x + dx + 1, y + dy) - pixel(plane, x + dx - 1, y + dy);
          const gy = pixel(plane, x + dx, y + dy + 1) - pixel(plane, x + dx, y + dy - 1);
          sxx += gx * gx;
          syy += gy * gy;
          sxy += gx * gy;
        }
      }
      const tr = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const minEig = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      if (minEig > 4000) candidates.push({ score: minEig, x, y });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen: PutterFeature[] = [];
  const inverse = pose.inverse;
  for (const cand of candidates) {
    const p = new Vec2(cand.x + 0.5, cand.y + 0.5);
    if (chosen.some((f) => f.calibrationPixel.distance(p) < 8)) continue;
    const w = c.worldFromImage(p);
    if (!w) continue;
    const local = inverse.apply(w);
    if (local.y >= -2 || Math.abs(local.x) >= halfWidth + 10) continue;
    chosen.push({ local, calibrationPixel: p });
    if (chosen.length >= maxCount) break;
  }
  return chosen;
}

function parabola(a: number, b: number, c: number) {
  const d = a - 2 * b + c;
  if (Math.abs(d) <= 1e-9) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
}

export class FeatureSource {
  patchRadius = 5;
  minScore = 0.72;
  private template = new Float64Array(0);
  private scores = new Float64Array(0);

  /** Match each feature against its predicted appearance near its predicted position, then fit one rigid pose. */
  observe(
    plane: LumaPlane,
    c: PuttingCoordinateSystem,
    cal: PutterCalibration,
    pose: RigidTransform,
    searchPixels: number,
    t: number,
  ): PutterObservation | null {
    const reference = cal.reference;
    if (!reference || cal.features.length < 3) return null;
    // current pixel -> world now -> local -> world at calibration -> calibration pixel
    const warp = mul3(mul3(mul3(c.surface.worldToImage, cal.pose.matrix), pose.inverse.matrix), c.surface.imageToWorld);
    const pr = this.patchRadius;
    const side = 2 * pr + 1;
    const count = side * side;
    if (this.template.length !== count) this.template = new Float64Array(count);
    const s = Math.max(1, searchPixels);
    const grid = 2 * s + 1;
    if (this.scores.length < grid * grid) this.scores = new Float64Array(grid * grid);
    const tpl = this.template;
    const scores = this.scores;
    const d = plane.data;
    const stride = plane.stride;
    const inverse = pose.inverse;
    let locals: Vec2[] = [];
    let worlds: Vec2[] = [];
    let weights: number[] = [];
    let debug: Vec2[] = [];

    for (const f of cal.features) {
      const predicted = c.imageFromWorld(pose.apply(f.local));
      if (!predicted) continue;
      const cx = Math.floor(predicted.x);
      const cy = Math.floor(predicted.y);
      if (cx - pr - s - 1 < 0 || cy - pr - s - 1 < 0 || cx + pr + s + 1 >= plane.width || cy + pr + s + 1 >= plane.height) continue;
      // The predicted appearance, sampled from the calibration image through the warp.
      let ok = true;
      let tMean = 0;
      for (let dy = -pr; dy <= pr && ok; dy++) {
        for (let dx = -pr; dx <= pr; dx++) {
          const src = apply3(warp, new Vec2(cx + dx + 0.5, cy + dy + 0.5));
          const v = src ? sampleCrop(reference, src) : null;
          if (v === null) {
            ok = false;
            break;
          }
          tpl[(dy + pr) * side + dx + pr] = v;
          tMean += v;
        }
      }
      if (!ok) continue;
      tMean /= count;
      let tVar = 0;
      for (let i = 0; i < count; i++) {
        tpl[i] -= tMean;
        tVar += tpl[i] * tpl[i];
      }
      if (tVar <= count * 16) continue; // flat patch: nothing to lock onto
      const tNorm = Math.sqrt(tVar);

      let best = -1;
      let bx = 0;
      let by = 0;
      for (let oy = -s; oy <= s; oy++) {
        for (let ox = -s; ox <= s; ox++) {
          let total = 0;
          let totalSq = 0;
          let cross = 0;
          for (let dy = -pr; dy <= pr; dy++) {
            const row = (cy + oy + dy) * stride + cx + ox;
            const tRow = (dy + pr) * side + pr;
            for (let dx = -pr; dx <= pr; dx++) {
              const v = d[row + dx];
              total += v;
              totalSq += v * v;
              cross += v * tpl[tRow + dx];
            }
          }
          const variance = totalSq - (total * total) / count;
          const ncc = variance > 1 ? cross / (Math.sqrt(variance) * tNorm) : -1;
          scores[(oy + s) * grid + ox + s] = ncc;
          if (ncc > best) {
            best = ncc;
            bx = ox;
            by = oy;
          }
        }
      }
      if (best < this.minScore || Math.abs(bx) >= s || Math.abs(by) >= s) continue;
      const sc = (x: number, y: number) => scores[(y + s) * grid + x + s];
      const fx = parabola(sc(bx - 1, by), best, sc(bx + 1, by));
      const fy = parabola(sc(bx, by - 1), best, sc(bx, by + 1));
      const matched = new Vec2(cx + bx + 0.5 + fx, cy + by + 0.5 + fy);
      // The patch centre carried the local point of pixel (cx, cy) under the predicted pose.
      const centreWorld = c.worldFromImage(new Vec2(cx + 0.5, cy + 0.5));
      const matchedWorld = c.worldFromImage(matched);
      if (!centreWorld || !matchedWorld) continue;
      locals.push(inverse.apply(centreWorld));
      worlds.push(matchedWorld);
      weights.push((best - this.minScore) / (1 - this.minScore) + 0.05);
      debug.push(matched);
    }
    if (locals.length < 3) return null;
    let fit = RigidTransform.fit(locals, worlds, weights);
    if (!fit) return null;
    // Drop matches the others disagree with, then refit.
    const residuals = locals.map((l, i) => fit!.transform.apply(l).distance(worlds[i]));
    const median = [...residuals].sort((a, b) => a - b)[Math.floor(residuals.length / 2)];
    const keep = residuals.map((_, i) => i).filter((i) => residuals[i] <= Math.max(0.5, 3 * median));
    if (keep.length >= 3 && keep.length < locals.length) {
      const refit = RigidTransform.fit(keep.map((i) => locals[i]), keep.map((i) => worlds[i]), keep.map((i) => weights[i]));
      if (refit) {
        fit = refit;
        locals = keep.map((i) => locals[i]);
        worlds = keep.map((i) => worlds[i]);
        weights = keep.map((i) => weights[i]);
        debug = keep.map((i) => debug[i]);
      }
    }
    const mean = sum(locals).div(locals.length);
    const spread = locals.reduce((a, l) => a + l.distance(mean), 0) / locals.length;
    const n = locals.length;
    const posSigma = Math.max(0.12, fit.rms / Math.sqrt(n));
    const rotSigma = Math.max(radians(0.03), fit.rms / (Math.max(5, spread) * Math.sqrt(n)));
    const coverage = n / cal.features.length;
    const confidence = clampUnit(0.35 + coverage * 0.65) * clampUnit(fit.rms < 0.35 ? 1 : 0.35 / fit.rms);
    return fullObservation("features", t, fit.transform, rotSigma, posSigma, confidence, debug);
  }
}

// MARK: markers

export class MarkerSource {
  private blobs = new BlobDetector();

  /**
   * Stickers near where the prediction puts them, then a rigid fit. With no
   * prediction (reacquiring) the stickers are matched by shape inside `searchROI`.
   */
  observe(
    plane: LumaPlane,
    c: PuttingCoordinateSystem,
    cal: PutterCalibration,
    pose: RigidTransform | null,
    searchPixels: number,
    t: number,
    searchROI?: IntRect,
  ): PutterObservation | null {
    if (cal.markers.length < 3) return null;
    const mmpp = c.surface.mmPerPixelAtBall;
    const rPx = cal.markerRadiusMM / mmpp;
    const expectedArea = Math.PI * rPx * rPx;
    const predictedPixels = pose ? cal.markers.map((m) => c.imageFromWorld(pose.apply(m))) : null;
    const havePrediction = predictedPixels !== null && predictedPixels.every((p) => p !== null);
    let roi: IntRect;
    if (havePrediction) roi = IntRect.covering(predictedPixels as Vec2[], searchPixels + rPx * 2);
    else if (searchROI) roi = searchROI;
    else return null;
    const spots = this.blobs
      .detect(plane, roi, { kind: "brighterThan", value: cal.markerThreshold }, 1, Math.max(2, Math.floor(expectedArea * 0.3)), Math.floor(expectedArea * 3))
      .filter((b) => !b.touchesEdge && b.elongation < 2.5);
    if (spots.length < 2) return null;
    const centres = spots.map((b) => refineSpot(plane, b, false));
    const worlds = centres.map((p) => c.worldFromImage(p));
    if (worlds.some((w) => w === null)) return null;
    const worldPts = worlds as Vec2[];

    let matchedLocal: Vec2[] = [];
    let matchedWorld: Vec2[] = [];
    let matchedImage: Vec2[] = [];
    if (havePrediction) {
      const used = new Set<number>();
      (predictedPixels as Vec2[]).forEach((q, i) => {
        let pick = -1;
        let bestD = searchPixels + rPx;
        centres.forEach((p, j) => {
          if (used.has(j)) return;
          const dd = p.distance(q);
          if (dd < bestD) {
            bestD = dd;
            pick = j;
          }
        });
        if (pick >= 0) {
          used.add(pick);
          matchedLocal.push(cal.markers[i]);
          matchedWorld.push(worldPts[pick]);
          matchedImage.push(centres[pick]);
        }
      });
    } else {
      // Shape match: the triple of spots that best fits the sticker triangle.
      if (worldPts.length < 3) return null;
      let best: { rms: number; idx: number[] } | null = null;
      const n = Math.min(worldPts.length, 8);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          for (let k = 0; k < n; k++) {
            if (k === i || k === j) continue;
            const f = RigidTransform.fit(cal.markers, [worldPts[i], worldPts[j], worldPts[k]]);
            // Mirror-image orderings fit badly, so a wrong ordering loses on rms.
            if (f && f.rms < (best?.rms ?? 1.5)) best = { rms: f.rms, idx: [i, j, k] };
          }
        }
      }
      if (!best) return null;
      matchedLocal = cal.markers;
      matchedWorld = best.idx.map((i) => worldPts[i]);
      matchedImage = best.idx.map((i) => centres[i]);
    }
    if (matchedLocal.length < 2) return null;
    const fit = RigidTransform.fit(matchedLocal, matchedWorld);
    if (!fit || fit.rms >= 1.5) return null;
    const mean = sum(matchedLocal).div(matchedLocal.length);
    const spread = matchedLocal.reduce((a, l) => a + l.distance(mean), 0) / matchedLocal.length;
    const n = matchedLocal.length;
    // Centroids of clean stickers are good to a tenth of a pixel or so.
    const pointSigma = Math.max(0.08, fit.rms, mmpp * 0.1);
    const confidence = (n >= 3 ? 0.99 : 0.8) * clampUnit(fit.rms < 0.4 ? 1 : 0.4 / fit.rms);
    return fullObservation(
      "markers",
      t,
      fit.transform,
      Math.max(radians(0.02), pointSigma / (Math.max(5, spread) * Math.sqrt(n))),
      pointSigma / Math.sqrt(n),
      confidence,
      matchedImage,
    );
  }
}

// MARK: calibration

export type PutterCalibrationError = "putterNotOnLine" | "faceTooNarrow" | "noEdge";

/** Reads the putter while its face sits on the template's square line. */
export class PutterCalibrator {
  private blobs = new BlobDetector();

  /** Luma of clean template paper, and a darker quartile. */
  private paperLevel(plane: LumaPlane, c: PuttingCoordinateSystem) {
    const values: number[] = [];
    const frame = bounds(plane);
    for (let x = -135; x <= 135; x += 15) {
      for (const y of [120, 140, -60, -90]) {
        if (!(Math.abs(x) < 95 || Math.abs(x) > 125)) continue;
        const p = c.imageFromWorld(new Vec2(x, y));
        if (p && frame.contains(p)) values.push(sample(plane, p));
      }
    }
    values.sort((a, b) => a - b);
    if (values.length === 0) return 200;
    return values[Math.floor((values.length * 3) / 4)];
  }

  /** Is something dark covering the square line either side of the ball? Fraction covered. */
  lineCoverage(plane: LumaPlane, c: PuttingCoordinateSystem) {
    const paper = this.paperLevel(plane, c);
    let covered = 0;
    let total = 0;
    for (let x = -TEMPLATE.faceLineHalfLength; x <= TEMPLATE.faceLineHalfLength; x += 2) {
      // The ball disc is black; skip the columns where it touches the line.
      if (Math.abs(x) <= TEMPLATE_DISC_RADIUS + 2) continue;
      const p = c.imageFromWorld(new Vec2(x, TEMPLATE.faceLineY - 4));
      if (!p) continue;
      total++;
      if (sample(plane, p) < paper * 0.6) covered++;
    }
    return total > 0 ? covered / total : 0;
  }

  private hasFaceEdge(plane: LumaPlane, c: PuttingCoordinateSystem, x: number, faceY: number, paper: number) {
    const luma = (y: number) => {
      const p = c.imageFromWorld(new Vec2(x, y));
      return p ? sample(plane, p) : null;
    };
    const front = luma(faceY + 3);
    const back = luma(faceY - 3);
    const behind = luma(faceY - 7);
    if (front === null || back === null || behind === null) return false;
    // Paper (or ball) just in front, head just behind.
    return front > paper * 0.7 && back < paper * 0.55 && behind < paper * 0.55;
  }

  calibrate(
    plane: LumaPlane,
    c: PuttingCoordinateSystem,
    handedness: Handedness,
    t: number,
  ): { ok: true; calibration: PutterCalibration } | { ok: false; error: PutterCalibrationError } {
    const paper = this.paperLevel(plane, c);
    const faceY = TEMPLATE.faceLineY;
    const mmpp = c.surface.mmPerPixelAtBall;

    // 1. Heel and toe: the columns where a sharp dark edge sits right on the square line.
    const columnStep = 1;
    const edgeColumns: number[] = [];
    for (let x = -140; x <= 140; x += columnStep) if (this.hasFaceEdge(plane, c, x, faceY, paper)) edgeColumns.push(x);
    if (edgeColumns.length === 0) return { ok: false, error: "putterNotOnLine" };
    // Grow a run out from the column nearest the ball, bridging the middle where the black disc hides the edge.
    const maxGap = 2 * TEMPLATE_DISC_RADIUS;
    const sorted = [...edgeColumns].sort((a, b) => a - b);
    const seed = sorted.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    if (Math.abs(seed) >= 70) return { ok: false, error: "putterNotOnLine" };
    let lo = seed;
    let hi = seed;
    for (const v of sorted) {
      if (v <= hi) continue;
      if (v - hi <= maxGap) hi = v;
      else break;
    }
    for (const v of [...sorted].reverse()) {
      if (v >= lo) continue;
      if (lo - v <= maxGap) lo = v;
      else break;
    }
    // A column only counts when the edge is on it, so the true end is half a step out.
    lo -= columnStep / 2;
    hi += columnStep / 2;
    const halfWidth = (hi - lo) / 2;
    if (halfWidth <= 20) return { ok: false, error: "faceTooNarrow" };
    const centre = new Vec2((lo + hi) / 2, faceY);
    const pose = new RigidTransform(0, centre);

    // 2. The visible edge relative to the true face line. Only the ends have
    // clean paper in front at calibration; the ball disc hides the middle.
    const draft: PutterCalibration = {
      pose,
      faceHalfWidth: halfWidth,
      edgeOffset: 0,
      edgeAngle: 0,
      toeEnd: null,
      headLuma: 0,
      markers: [],
      markerRadiusMM: 0,
      markerThreshold: 255,
      features: [],
      reference: null,
      handedness,
      timestamp: t,
    };
    const outer = (u: number) => Math.abs(u + centre.x) > TEMPLATE_DISC_RADIUS + 3;
    const edge = measureEdge(plane, c, draft, pose, 6, outer, true);
    if (!edge) return { ok: false, error: "noEdge" };
    draft.edgeOffset = edge.offset;
    draft.edgeAngle = edge.rotation;
    draft.toeEnd = measureToeEnd(plane, c, draft, pose, toeSign(draft) * halfWidth);

    // 3. Head brightness, just behind the face.
    let total = 0;
    let n = 0;
    for (let u = -halfWidth * 0.7; u <= halfWidth * 0.7 + 1e-9; u += 2) {
      for (let v = -9; v <= -4 + 1e-9; v += 1.5) {
        const p = c.imageFromWorld(pose.apply(new Vec2(u, v)));
        if (p) {
          total += sample(plane, p);
          n++;
        }
      }
    }
    draft.headLuma = n > 0 ? total / n : 0;

    // 4. The head region and a reference copy of it.
    const depth = 110;
    const corners = [
      new Vec2(-halfWidth - 10, -depth),
      new Vec2(halfWidth + 10, -depth),
      new Vec2(halfWidth + 10, 4),
      new Vec2(-halfWidth - 10, 4),
    ].flatMap((p) => {
      const q = c.imageFromWorld(pose.apply(p));
      return q ? [q] : [];
    });
    const roi = IntRect.covering(corners, 4).clipped(bounds(plane));
    draft.reference = crop(plane, roi);

    // 5. Stickers: small round bright spots on the dark head.
    const stickerR = 4 / mmpp;
    const markerThreshold = Math.floor((draft.headLuma + paper) / 2);
    const spots = this.blobs.detect(
      plane,
      roi,
      { kind: "brighterThan", value: markerThreshold },
      1,
      Math.max(3, Math.floor(Math.PI * stickerR * stickerR * 0.25)),
      Math.floor(Math.PI * stickerR * stickerR * 6),
    );
    const markers: Array<{ local: Vec2; area: number }> = [];
    for (const s of spots) {
      if (s.touchesEdge || s.elongation >= 1.6 || s.fillRatio <= 0.5) continue;
      const ring = new IntRect(s.bounds.minX - 3, s.bounds.minY - 3, s.bounds.width + 6, s.bounds.height + 6);
      // Surrounded by head, not by paper.
      if (ringMean(plane, ring, s.bounds) >= markerThreshold - 10) continue;
      const w = c.worldFromImage(refineSpot(plane, s, false));
      if (!w) continue;
      const local = pose.inverse.apply(w);
      if (local.y >= -2 || Math.abs(local.x) >= halfWidth + 5) continue;
      markers.push({ local, area: s.area });
    }
    if (markers.length >= 3) {
      draft.markers = widestTriangle(markers.map((m) => m.local));
      const meanArea = markers.reduce((a, m) => a + m.area, 0) / markers.length;
      draft.markerRadiusMM = Math.sqrt(meanArea / Math.PI) * mmpp;
      draft.markerThreshold = markerThreshold;
    }

    // 6. Texture features inside the head, away from its outline.
    draft.features = selectFeatures(plane, c, pose, roi, draft.headLuma, paper, halfWidth);
    return { ok: true, calibration: draft };
  }
}

function ringMean(plane: LumaPlane, outer: IntRect, inner: IntRect) {
  const r = outer.clipped(bounds(plane));
  let s = 0;
  let n = 0;
  for (let y = r.minY; y < r.maxY; y++) {
    for (let x = r.minX; x < r.maxX; x++) {
      if (x >= inner.minX && x < inner.maxX && y >= inner.minY && y < inner.maxY) continue;
      s += pixel(plane, x, y);
      n++;
    }
  }
  return n > 0 ? s / n : 255;
}

/** The three points spanning the largest triangle: the most leverage on rotation. */
export function widestTriangle(pts: Vec2[]): Vec2[] {
  if (pts.length <= 3) return pts;
  let best = pts.slice(0, 3);
  let bestArea = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        const a = Math.abs(pts[j].sub(pts[i]).cross(pts[k].sub(pts[i])));
        if (a > bestArea) {
          bestArea = a;
          best = [pts[i], pts[j], pts[k]];
        }
      }
    }
  }
  return best;
}
