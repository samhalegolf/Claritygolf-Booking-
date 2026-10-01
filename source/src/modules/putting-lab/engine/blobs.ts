import { clampUnit, Vec2 } from "./geometry";
import { bounds, IntRect, type LumaPlane } from "./luma";

/** One connected region of foreground pixels. */
export class Blob {
  constructor(
    readonly area: number,
    /** Plain centroid in frame pixels (pixel centres at +0.5). */
    readonly centroid: Vec2,
    readonly bounds: IntRect,
    /** Central second moments per unit area. */
    readonly mxx: number,
    readonly myy: number,
    readonly mxy: number,
    /** Reached the edge of the region searched, so may be cut off. */
    readonly touchesEdge: boolean,
  ) {}

  /** area / bounding-box area: ~0.785 for a filled disc, far lower for a ring or a line. */
  get fillRatio() {
    return this.bounds.area > 0 ? this.area / this.bounds.area : 0;
  }

  /** Principal-axis variances (major, minor). */
  get axes(): [number, number] {
    const tr = this.mxx + this.myy;
    const det = this.mxx * this.myy - this.mxy * this.mxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    return [tr / 2 + disc, Math.max(0, tr / 2 - disc)];
  }

  /** Ratio of the principal axes (1 for a disc, large for a bar). */
  get elongation() {
    const [a, b] = this.axes;
    return b > 1e-9 ? Math.sqrt(a / b) : Infinity;
  }

  get equivalentRadius() {
    return Math.sqrt(this.area / Math.PI);
  }
}

export type BlobThreshold =
  | { kind: "darkerThan"; value: number }
  | { kind: "brighterThan"; value: number }
  /** Darker than the local mean of a `window`-pixel box by `offset`: survives uneven light. */
  | { kind: "adaptiveDark"; window: number; offset: number };

/** Connected components over a region, with buffers reused between calls. */
export class BlobDetector {
  private mask = new Uint8Array(0);
  private labels = new Int32Array(0);
  private stack = new Int32Array(0);
  private integral = new Uint32Array(0);

  /**
   * Blobs in `roi`. With `step > 1` the region is sampled every `step` pixels;
   * positions still come back in full-frame pixels. Area limits are in
   * sampled pixels.
   */
  detect(plane: LumaPlane, roi: IntRect, threshold: BlobThreshold, step = 1, minArea = 1, maxArea = Infinity): Blob[] {
    const r = roi.clipped(bounds(plane));
    const s = Math.max(1, step);
    const w = Math.floor(r.width / s);
    const h = Math.floor(r.height / s);
    if (w <= 0 || h <= 0) return [];
    const n = w * h;
    if (this.mask.length < n) this.mask = new Uint8Array(n);
    if (this.labels.length < n) this.labels = new Int32Array(n);
    if (this.stack.length < n) this.stack = new Int32Array(n);
    this.buildMask(plane, r, s, w, h, threshold);

    const mask = this.mask;
    const labels = this.labels;
    const stack = this.stack;
    labels.fill(0, 0, n);
    const blobs: Blob[] = [];
    let next = 1;
    for (let start = 0; start < n; start++) {
      if (mask[start] === 0 || labels[start] !== 0) continue;
      labels[start] = next;
      let top = 0;
      stack[top++] = start;
      let area = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let edge = false;
      while (top > 0) {
        const i = stack[--top];
        const px = i % w;
        const py = (i - px) / w;
        area++;
        sx += px;
        sy += py;
        sxx += px * px;
        syy += py * py;
        sxy += px * py;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        if (px === 0 || py === 0 || px === w - 1 || py === h - 1) edge = true;
        // 4-connected: diagonal touches do not merge separate dots.
        if (px > 0 && mask[i - 1] && !labels[i - 1]) {
          labels[i - 1] = next;
          stack[top++] = i - 1;
        }
        if (px < w - 1 && mask[i + 1] && !labels[i + 1]) {
          labels[i + 1] = next;
          stack[top++] = i + 1;
        }
        if (py > 0 && mask[i - w] && !labels[i - w]) {
          labels[i - w] = next;
          stack[top++] = i - w;
        }
        if (py < h - 1 && mask[i + w] && !labels[i + w]) {
          labels[i + w] = next;
          stack[top++] = i + w;
        }
      }
      next++;
      if (area < minArea || area > maxArea) continue;
      const mx = sx / area;
      const my = sy / area;
      blobs.push(
        new Blob(
          area,
          new Vec2(r.minX + (mx + 0.5) * s, r.minY + (my + 0.5) * s),
          new IntRect(r.minX + x0 * s, r.minY + y0 * s, (x1 - x0 + 1) * s, (y1 - y0 + 1) * s),
          (sxx / area - mx * mx) * s * s,
          (syy / area - my * my) * s * s,
          (sxy / area - mx * my) * s * s,
          edge,
        ),
      );
    }
    return blobs;
  }

  private buildMask(plane: LumaPlane, r: IntRect, s: number, w: number, h: number, threshold: BlobThreshold) {
    const mask = this.mask;
    const d = plane.data;
    if (threshold.kind === "darkerThan" || threshold.kind === "brighterThan") {
      const t = threshold.value;
      const dark = threshold.kind === "darkerThan";
      for (let y = 0; y < h; y++) {
        const row = (r.minY + y * s) * plane.stride + r.minX;
        for (let x = 0; x < w; x++) {
          const v = d[row + x * s];
          mask[y * w + x] = (dark ? v <= t : v > t) ? 1 : 0;
        }
      }
      return;
    }
    // Integral image over the sampled grid, with a zero row and column.
    const iw = w + 1;
    const needed = iw * (h + 1);
    if (this.integral.length < needed) this.integral = new Uint32Array(needed);
    const integral = this.integral;
    integral.fill(0, 0, iw);
    for (let y = 0; y < h; y++) {
      integral[(y + 1) * iw] = 0;
      let rowSum = 0;
      const row = (r.minY + y * s) * plane.stride + r.minX;
      for (let x = 0; x < w; x++) {
        rowSum += d[row + x * s];
        integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + rowSum;
      }
    }
    const half = Math.max(1, Math.floor(threshold.window / s / 2));
    const offset = threshold.offset;
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - half);
      const yb = Math.min(h, y + half + 1);
      const row = (r.minY + y * s) * plane.stride + r.minX;
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - half);
        const xb = Math.min(w, x + half + 1);
        const total = integral[yb * iw + xb] - integral[ya * iw + xb] - integral[yb * iw + xa] + integral[ya * iw + xa];
        const count = (yb - ya) * (xb - xa);
        mask[y * w + x] = d[row + x * s] * count < total - offset * count ? 1 : 0;
      }
    }
  }
}

/**
 * Sub-pixel centre of a dark or bright spot: an intensity-weighted centroid
 * against the local background, at full resolution. Much steadier than a
 * thresholded centroid, which moves in whole pixels as the edge flickers.
 */
export function refineSpot(plane: LumaPlane, blob: Blob, dark: boolean): Vec2 {
  const pad = Math.max(3, Math.floor(blob.equivalentRadius * 0.8));
  const b = blob.bounds;
  const rect = new IntRect(b.minX - pad, b.minY - pad, b.width + 2 * pad, b.height + 2 * pad).clipped(bounds(plane));
  if (rect.area <= 0) return blob.centroid;
  const d = plane.data;
  let bg = 0;
  let bgCount = 0;
  let lo = 255;
  let hi = 0;
  for (let y = rect.minY; y < rect.maxY; y++) {
    const row = y * plane.stride;
    for (let x = rect.minX; x < rect.maxX; x++) {
      const v = d[row + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      const inside = x >= b.minX && x < b.maxX && y >= b.minY && y < b.maxY;
      if (!inside) {
        bg += v;
        bgCount++;
      }
    }
  }
  if (bgCount === 0) return blob.centroid;
  const background = bg / bgCount;
  const core = dark ? lo : hi;
  if (Math.abs(background - core) <= 8) return blob.centroid;
  const span = Math.abs(background - core);
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let y = rect.minY; y < rect.maxY; y++) {
    const row = y * plane.stride;
    for (let x = rect.minX; x < rect.maxX; x++) {
      const v = d[row + x];
      // How far toward the spot's core this pixel is, 0..1; the faint tail is noise.
      const wgt = clampUnit((dark ? background - v : v - background) / span);
      if (wgt <= 0.15) continue;
      sw += wgt;
      sx += wgt * (x + 0.5);
      sy += wgt * (y + 0.5);
    }
  }
  return sw > 0 ? new Vec2(sx / sw, sy / sw) : blob.centroid;
}
