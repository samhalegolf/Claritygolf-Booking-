/**
 * The clubhead detector, against frames whose contents are known exactly.
 *
 * Rendered here rather than decoded from a video: a software rasteriser is
 * about forty lines and gives something no real clip can -- the true pixel
 * the clubhead is at. Every assertion below is against that.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { detectClubhead, type ClubheadHint } from "./clubheadDetector";
import { toGrayFrame, differenceOf, type GrayFrame } from "./grayFrame";

const WIDTH = 320;
const HEIGHT = 180;

interface Disc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly grey: number;
}

/** A frame: a flat background, some shapes, a little deterministic grain. */
const render = (discs: readonly Disc[], noise = 3, seed = 1): GrayFrame => {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  let state = seed >>> 0;
  const grain = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return ((state >>> 16) / 65535 - 0.5) * 2 * noise;
  };

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      let value = 70 + grain();
      for (const disc of discs) {
        if ((x - disc.x) ** 2 + (y - disc.y) ** 2 <= disc.radius ** 2) value = disc.grey;
      }
      const offset = (y * WIDTH + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return toGrayFrame(rgba, WIDTH, HEIGHT, WIDTH / 2);
};

/** A body that barely moves, and a clubhead that moves a lot. */
const torso: Disc = { x: 150, y: 95, radius: 26, grey: 150 };
const head: Disc = { x: 150, y: 55, radius: 13, grey: 165 };

const hint: ClubheadHint = {
  // Normalised, Y down. The hands sit just below the torso.
  hands: [150 / WIDTH, 120 / WIDTH],
  bodyPoints: [
    [150 / WIDTH, 95 / WIDTH],
    [150 / WIDTH, 55 / WIDTH],
    [150 / WIDTH, 130 / WIDTH],
  ],
  bodyMaskRadius: 32 / WIDTH,
  minReach: 30 / WIDTH,
  maxReach: 150 / WIDTH,
};

const clubAt = (x: number, y: number): Disc => ({ x, y, radius: 5, grey: 235 });

/**
 * A clubhead smeared along its path, the way a real exposure records it.
 *
 * Without this the fixture is unrealistically kind: a sharp clubhead at two
 * separated positions produces two clean blobs, where a real camera produces
 * one streak. Testing against the kind version would leave the streak case
 * untested, which is the case that actually happens.
 */
const clubStreak = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): Disc[] =>
  Array.from({ length: 9 }, (_value, i) => {
    const t = i / 8;
    return clubAt(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
  });

/** Where a detection landed, in source pixels, for readable failures. */
const inPixels = (detection: { imageX: number; imageY: number }) => ({
  x: detection.imageX * WIDTH,
  y: detection.imageY * WIDTH,
});

/* ------------------------------------------------------------------ */

test("a moving clubhead is found, and a still body is not", () => {
  const before = render([torso, head, ...clubStreak(40, 160, 60, 150)]);
  const during = render([torso, head, ...clubStreak(60, 150, 90, 130)], 3, 2);
  const after = render([torso, head, ...clubStreak(90, 130, 125, 108)], 3, 3);

  const detection = detectClubhead(before, during, after, hint);
  assert.ok(detection, "no clubhead found");

  // Somewhere along the streak this frame covers, 60,150 to 90,130.
  const { x, y } = inPixels(detection);
  assert.ok(x > 50 && x < 100, `found at x=${x.toFixed(0)}, off the frame's streak`);
  assert.ok(y > 120 && y < 160, `found at y=${y.toFixed(0)}`);
  assert.ok(detection.confidence > 0.4, `confidence ${detection.confidence.toFixed(2)}`);
});

test("three frames tell where the club IS from where it WAS", () => {
  /*
   * The reason a third frame is used at all. With two frames the difference
   * lights up equally at the old and new positions, and the detector has no
   * way to prefer the right one. The current position differs from BOTH
   * neighbours; the old one differs only from the previous frame.
   */
  const before = render([torso, head, clubAt(60, 150)]);
  const during = render([torso, head, clubAt(120, 110)], 3, 2);
  const after = render([torso, head, clubAt(180, 80)], 3, 3);

  const threeFrame = detectClubhead(before, during, after, hint);
  assert.ok(threeFrame, "nothing found with three frames");

  const { x } = inPixels(threeFrame);
  assert.ok(
    Math.abs(x - 120) < 18,
    `three-frame detection landed at x=${x.toFixed(0)}, not the current position (120)`
  );
});

test("a body that moves is not mistaken for a club", () => {
  // The torso shifts several pixels -- more than a real one would between
  // frames -- and there is no club at all. Nothing should be reported.
  const before = render([torso, head]);
  const during = render([{ ...torso, x: torso.x + 5 }, { ...head, x: head.x + 4 }], 3, 2);
  const after = render([{ ...torso, x: torso.x + 10 }, { ...head, x: head.x + 8 }], 3, 3);

  assert.equal(detectClubhead(before, during, after, hint), null);
});

test("a still frame reports nothing rather than guessing", () => {
  const frame = render([torso, head, clubAt(60, 150)]);
  assert.equal(detectClubhead(frame, frame, frame, hint), null);
});

test("movement beyond a club's reach is ignored", () => {
  // Someone walking past in the background, well outside the arc.
  const walker = { x: 314, y: 14, radius: 6, grey: 220 };
  const before = render([torso, head, walker]);
  const during = render([torso, head, { ...walker, x: 302 }], 3, 2);
  const after = render([torso, head, { ...walker, x: 290 }], 3, 3);

  assert.equal(
    detectClubhead(before, during, after, hint),
    null,
    "something outside the club's reach was reported as a clubhead"
  );
});

test("the club is preferred over slower movement inside the same region", () => {
  // A hand-sized object drifting a couple of pixels, and a clubhead flying.
  const drifter = { x: 210, y: 150, radius: 8, grey: 120 };
  const before = render([torso, head, drifter, ...clubStreak(40, 50, 70, 60)]);
  const during = render(
    [torso, head, { ...drifter, x: 212 }, ...clubStreak(70, 60, 105, 75)],
    3,
    2
  );
  const after = render(
    [torso, head, { ...drifter, x: 214 }, ...clubStreak(105, 75, 140, 95)],
    3,
    3
  );

  const detection = detectClubhead(before, during, after, hint);
  assert.ok(detection);
  const { x } = inPixels(detection);
  assert.ok(
    x > 60 && x < 115,
    `found at x=${x.toFixed(0)}, which is the drifter rather than the club`
  );
});

test("a faster club reports a wider, less certain detection", () => {
  // The radius is the honesty channel: a blurred clubhead spans further, and
  // the club model downstream is entitled to know.
  const slow = detectClubhead(
    render([torso, head, ...clubStreak(62, 154, 70, 150)]),
    render([torso, head, ...clubStreak(70, 150, 80, 145)], 3, 2),
    render([torso, head, ...clubStreak(80, 145, 90, 140)], 3, 3),
    hint
  );
  const fast = detectClubhead(
    render([torso, head, ...clubStreak(20, 185, 70, 150)]),
    render([torso, head, ...clubStreak(70, 150, 125, 110)], 3, 2),
    render([torso, head, ...clubStreak(125, 110, 180, 70)], 3, 3),
    hint
  );

  assert.ok(slow && fast);
  assert.ok(
    fast.imageRadius > slow.imageRadius * 1.5,
    `fast ${fast.imageRadius.toFixed(4)} should span more than slow ${slow.imageRadius.toFixed(4)}`
  );
});

test("grain alone is not a clubhead", () => {
  const before = render([torso, head], 8, 11);
  const during = render([torso, head], 8, 99);
  const after = render([torso, head], 8, 41);
  assert.equal(
    detectClubhead(before, during, after, hint),
    null,
    "sensor noise was reported as a clubhead"
  );
});

test("a whole-frame change is rejected as a camera move", () => {
  // Everything shifts: a pan, a shake, an exposure jump. Not a club.
  const before = render([torso, head, clubAt(60, 150)], 3, 1);
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(200);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const during = toGrayFrame(rgba, WIDTH, HEIGHT, WIDTH / 2);
  const after = render([torso, head, clubAt(60, 150)], 3, 4);

  assert.equal(
    detectClubhead(before, during, after, hint),
    null,
    "a whole-frame change was reported as a clubhead"
  );
});

test("frames of different sizes are refused, not silently compared", () => {
  const a = render([torso]);
  const b: GrayFrame = { width: a.width + 2, height: a.height, data: a.data };
  assert.equal(detectClubhead(a, b, null, hint), null);
  assert.equal(detectClubhead(a, a, b, hint), null);
});

/* ---------------------------- grayFrame ----------------------------- */

test("downsampling averages rather than samples", () => {
  /*
   * A point-sampled downscale would hit a small moving clubhead on some
   * frames and miss it on others, turning a smooth track into a flicker --
   * which the Motion Layer would then spend its effort undoing.
   */
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) {
    const value = i % 2 === 0 ? 0 : 200;
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }

  const gray = toGrayFrame(rgba, 4, 4, 2);
  assert.equal(gray.width, 2);
  assert.equal(gray.height, 2);
  // Every 2x2 block holds two black and two bright pixels.
  for (const value of gray.data) {
    assert.ok(Math.abs(value - 100) < 2, `expected the average, got ${value}`);
  }
});

test("the difference of a frame with itself is empty", () => {
  const frame = render([torso, head, clubAt(60, 150)]);
  const difference = differenceOf(frame, frame);
  assert.ok(difference.data.every((value) => value === 0));
});
