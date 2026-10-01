// Everything is measured on luma (brightness). The browser hands over RGBA;
// the frame pump converts it once into one byte per pixel.
//
// Pixel convention: pixel (i, j) covers [i, i+1) x [j, j+1), so its centre is
// (i + 0.5, j + 0.5). Every centroid, sample and homography uses these
// continuous coordinates.

import { Vec2 } from "./geometry";

export type LumaPlane = {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Bytes per row (>= width). */
  readonly stride: number;
};

export function makePlane(width: number, height: number, fill = 0): LumaPlane {
  const data = new Uint8Array(width * height);
  if (fill) data.fill(fill);
  return { data, width, height, stride: width };
}

/** RGBA -> luma (Rec. 601 weights, integer maths). */
export function lumaFromRGBA(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, out?: Uint8Array): LumaPlane {
  const n = width * height;
  const data = out && out.length >= n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { data, width, height, stride: width };
}

export class IntRect {
  readonly width: number;
  readonly height: number;
  constructor(
    readonly x: number,
    readonly y: number,
    width: number,
    height: number,
  ) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
  }

  /** The smallest rect holding every point, grown by `margin` pixels. */
  static covering(points: readonly Vec2[], margin: number) {
    if (points.length === 0) return new IntRect(0, 0, 0, 0);
    let lx = points[0].x;
    let ly = points[0].y;
    let hx = lx;
    let hy = ly;
    for (const p of points) {
      lx = Math.min(lx, p.x);
      ly = Math.min(ly, p.y);
      hx = Math.max(hx, p.x);
      hy = Math.max(hy, p.y);
    }
    const x0 = Math.floor(lx - margin);
    const y0 = Math.floor(ly - margin);
    return new IntRect(x0, y0, Math.ceil(hx + margin) - x0, Math.ceil(hy + margin) - y0);
  }

  get minX() {
    return this.x;
  }
  get minY() {
    return this.y;
  }
  get maxX() {
    return this.x + this.width;
  }
  get maxY() {
    return this.y + this.height;
  }
  get area() {
    return this.width * this.height;
  }

  clipped(b: IntRect) {
    const x0 = Math.max(this.minX, b.minX);
    const y0 = Math.max(this.minY, b.minY);
    return new IntRect(x0, y0, Math.min(this.maxX, b.maxX) - x0, Math.min(this.maxY, b.maxY) - y0);
  }

  contains(p: Vec2) {
    return p.x >= this.minX && p.x < this.maxX && p.y >= this.minY && p.y < this.maxY;
  }
}

export const bounds = (plane: LumaPlane) => new IntRect(0, 0, plane.width, plane.height);

export const pixel = (plane: LumaPlane, x: number, y: number) => plane.data[y * plane.stride + x];

/** Bilinear sample at a continuous point (pixel centres at +0.5). Clamps at the border. */
export function sample(plane: LumaPlane, p: Vec2) {
  const fx = p.x - 0.5;
  const fy = p.y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const w = plane.width - 1;
  const h = plane.height - 1;
  const xa = Math.min(Math.max(x0, 0), w);
  const xb = Math.min(Math.max(x0 + 1, 0), w);
  const ya = Math.min(Math.max(y0, 0), h);
  const yb = Math.min(Math.max(y0 + 1, 0), h);
  const d = plane.data;
  const r0 = ya * plane.stride;
  const r1 = yb * plane.stride;
  const top = d[r0 + xa] * (1 - ax) + d[r0 + xb] * ax;
  const bottom = d[r1 + xa] * (1 - ax) + d[r1 + xb] * ax;
  return top * (1 - ay) + bottom * ay;
}

export function meanIn(plane: LumaPlane, rect: IntRect) {
  const r = rect.clipped(bounds(plane));
  if (r.area <= 0) return 0;
  let s = 0;
  for (let y = r.minY; y < r.maxY; y++) {
    const row = y * plane.stride;
    for (let x = r.minX; x < r.maxX; x++) s += plane.data[row + x];
  }
  return s / r.area;
}

/** An owned copy of part of a frame, remembering where it came from. */
export type LumaCrop = { plane: LumaPlane; originX: number; originY: number };

export function crop(plane: LumaPlane, rect: IntRect): LumaCrop {
  const r = rect.clipped(bounds(plane));
  const out = makePlane(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const src = (r.minY + y) * plane.stride + r.minX;
    out.data.set(plane.data.subarray(src, src + r.width), y * r.width);
  }
  return { plane: out, originX: r.minX, originY: r.minY };
}

/** Bilinear sample of a crop in the coordinates of the frame it was cut from. */
export function sampleCrop(c: LumaCrop, p: Vec2): number | null {
  const lx = p.x - c.originX;
  const ly = p.y - c.originY;
  if (lx < 0.5 || ly < 0.5 || lx > c.plane.width - 0.5 || ly > c.plane.height - 0.5) return null;
  return sample(c.plane, new Vec2(lx, ly));
}

export function histogram(plane: LumaPlane, rect: IntRect, step = 1) {
  const h = new Array<number>(256).fill(0);
  const r = rect.clipped(bounds(plane));
  for (let y = r.minY; y < r.maxY; y += step) {
    const row = y * plane.stride;
    for (let x = r.minX; x < r.maxX; x += step) h[plane.data[row + x]]++;
  }
  return h;
}

/** Otsu threshold and its separability (between-class / total variance, 0..1). */
export function otsu(h: readonly number[]) {
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) {
    total += h[i];
    sumAll += i * h[i];
  }
  if (total === 0) return { threshold: 128, separability: 0 };
  const mean = sumAll / total;
  let variance = 0;
  for (let i = 0; i < 256; i++) variance += h[i] * (i - mean) * (i - mean);
  variance /= total;
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += h[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * h[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = (wB * wF * (mB - mF) * (mB - mF)) / total / total;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return { threshold, separability: variance > 0 ? Math.min(1, best / variance) : 0 };
}
