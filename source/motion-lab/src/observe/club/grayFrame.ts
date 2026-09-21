/**
 * Video frames reduced to something a detector can work on.
 *
 * Downsampled hard and turned to a single channel. Both of those are
 * deliberate:
 *
 *   The clubhead is found by MOTION, and motion survives downsampling far
 *   better than detail does. Working at a fraction of the resolution makes
 *   the search cheap enough to run on every frame, and averaging pixels
 *   together is itself a noise filter.
 *
 *   Colour is no help. A clubhead can be chrome, black or white, against
 *   grass, sky or a net. What distinguishes it is that it is the fastest
 *   thing in the picture, which is a question about brightness over time.
 */

export interface GrayFrame {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, row-major. */
  readonly data: Uint8ClampedArray;
}

/** Rec. 709 luma. The weights matter: green carries most of the detail. */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * RGBA pixels to a downsampled grayscale frame.
 *
 * Box-averaged rather than sampled. Point sampling a moving clubhead at a
 * fifth of the resolution would hit it on some frames and miss it on others,
 * turning a smooth track into a flicker -- exactly the artefact the Motion
 * Layer downstream would then have to work to remove.
 */
export const toGrayFrame = (
  rgba: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number
): GrayFrame => {
  const scale = Math.max(1, Math.round(sourceWidth / Math.max(1, targetWidth)));
  const width = Math.max(1, Math.floor(sourceWidth / scale));
  const height = Math.max(1, Math.floor(sourceHeight / scale));
  const data = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let dy = 0; dy < scale; dy += 1) {
        const sourceY = y * scale + dy;
        if (sourceY >= sourceHeight) break;
        for (let dx = 0; dx < scale; dx += 1) {
          const sourceX = x * scale + dx;
          if (sourceX >= sourceWidth) break;
          const offset = (sourceY * sourceWidth + sourceX) * 4;
          total += luma(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
          count += 1;
        }
      }
      data[y * width + x] = count === 0 ? 0 : total / count;
    }
  }

  return { width, height, data };
};

/** Absolute difference between two frames of the same size. */
export const differenceOf = (a: GrayFrame, b: GrayFrame): GrayFrame => {
  const data = new Uint8ClampedArray(a.data.length);
  for (let i = 0; i < a.data.length; i += 1) {
    data[i] = Math.abs(a.data[i] - b.data[i]);
  }
  return { width: a.width, height: a.height, data };
};
