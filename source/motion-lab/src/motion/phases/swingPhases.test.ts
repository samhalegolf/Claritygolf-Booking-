import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ObservationFrame, RawLandmark } from "../../observe/observation";
import { findSwingPhases } from "./swingPhases";

const FPS = 60;

/** Eased 0..1 between two times. */
const ease = (t: number, from: number, to: number) => {
  const k = Math.min(1, Math.max(0, (t - from) / (to - from)));
  return 0.5 - Math.cos(Math.PI * k) / 2;
};

/**
 * A face-on swing drawn by hand, in image space (Y down):
 *   still at address until 1.0s, hands rise to the top by 1.8s, fall fast
 *   to impact at 2.05s, rise to the finish by 2.5s, then hold.
 */
const handsAt = (t: number): [number, number] => {
  if (t < 1.0) return [0.5, 0.7];
  if (t < 1.8) {
    const k = ease(t, 1.0, 1.8);
    return [0.5 - 0.15 * k, 0.7 - 0.4 * k];
  }
  if (t < 2.05) {
    const k = ease(t, 1.8, 2.05);
    return [0.35 + 0.15 * k, 0.3 + 0.42 * k];
  }
  if (t < 2.5) {
    const k = ease(t, 2.05, 2.5);
    return [0.5 + 0.15 * k, 0.72 - 0.47 * k];
  }
  return [0.65, 0.25];
};

const point = (x: number, y: number, visibility = 1): RawLandmark => ({ x, y, z: 0, visibility });

const swing = (seconds: number, hide?: (t: number) => boolean): ObservationFrame[] =>
  Array.from({ length: Math.round(seconds * FPS) }, (_, index) => {
    const t = index / FPS;
    const [hx, hy] = handsAt(t);
    const image = Array.from({ length: 33 }, () => point(0.5, 0.5));
    image[11] = point(0.45, 0.35);
    image[12] = point(0.55, 0.35);
    image[23] = point(0.47, 0.6);
    image[24] = point(0.53, 0.6);
    const seen = hide?.(t) ? 0 : 1;
    image[15] = point(hx - 0.01, hy, seen);
    image[16] = point(hx + 0.01, hy, seen);
    return { index, timestampMs: t * 1000, detected: true, image, world: null, club: null };
  });

const near = (actualMs: number | undefined, expectedS: number, toleranceS: number, name: string) => {
  assert.ok(actualMs !== undefined, `${name} was not found`);
  assert.ok(
    Math.abs(actualMs / 1000 - expectedS) <= toleranceS,
    `${name} at ${(actualMs / 1000).toFixed(3)}s, expected ${expectedS}s ±${toleranceS}`
  );
};

test("finds each phase of a clean swing where it happened", () => {
  const { phases, failure } = findSwingPhases(swing(4));
  assert.equal(failure, null);
  near(phases.setup?.timeMs, 1.0, 0.1, "setup");
  near(phases.top?.timeMs, 1.8, 0.05, "top");
  near(phases.impact?.timeMs, 2.05, 0.05, "impact");
  near(phases.finish?.timeMs, 2.5, 0.12, "finish");
  // Path-fraction phases sit strictly between their neighbours.
  assert.ok(phases.takeaway!.timeMs > phases.setup!.timeMs && phases.takeaway!.timeMs < phases.top!.timeMs);
  assert.ok(phases.delivery!.timeMs > phases.top!.timeMs && phases.delivery!.timeMs < phases.impact!.timeMs);
});

test("the phases come out in swing order", () => {
  const { phases } = findSwingPhases(swing(4));
  const times = [phases.setup, phases.takeaway, phases.top, phases.delivery, phases.impact, phases.finish].map(
    (phase) => phase!.timeMs
  );
  assert.deepEqual([...times].sort((a, b) => a - b), times);
});

test("a dropout around the top lowers confidence there without moving the swing", () => {
  const { phases } = findSwingPhases(swing(4, (t) => t > 1.75 && t < 1.85));
  near(phases.impact?.timeMs, 2.05, 0.06, "impact");
  assert.ok(phases.top!.confidence < 1);
  assert.equal(phases.finish!.confidence, 1);
});

test("a clip with no swing in it is a failure, not six guesses", () => {
  const still = swing(4).map((frame) => ({ ...frame, timestampMs: frame.timestampMs }));
  const frozen = still.map((frame) => ({ ...frame, image: still[0].image }));
  const { phases, failure } = findSwingPhases(frozen);
  assert.ok(failure);
  assert.deepEqual(phases, {});
});

test("hands never seen is a failure", () => {
  const { failure } = findSwingPhases(swing(4, () => true));
  assert.ok(failure);
});

/**
 * The shape of a real phone clip that broke the first version: slow motion
 * re-timed to 30fps, a pause at the top, and a release after impact that is
 * faster than the downswing. Address to 1.0s, top reached at 3.0s and held
 * to 3.4s, impact at 4.6s, the hands whipped up to the finish by 5.0s.
 */
const slowMotionHands = (t: number): [number, number] => {
  if (t < 1.0) return [0.5, 0.7];
  if (t < 3.0) {
    const k = ease(t, 1.0, 3.0);
    return [0.5 - 0.15 * k, 0.7 - 0.43 * k];
  }
  if (t < 3.4) return [0.35, 0.27];
  if (t < 4.6) {
    const k = ease(t, 3.4, 4.6);
    return [0.35 + 0.15 * k, 0.27 + 0.28 * k];
  }
  if (t < 5.0) {
    const k = ease(t, 4.6, 5.0);
    return [0.5 + 0.2 * k, 0.55 - 0.32 * k];
  }
  return [0.7, 0.23];
};

const slowMotionSwing = () =>
  Array.from({ length: Math.round(7 * 30) }, (_, index) => {
    const t = index / 30;
    const [hx, hy] = slowMotionHands(t);
    const image = Array.from({ length: 33 }, () => point(0.5, 0.5));
    image[11] = point(0.45, 0.35);
    image[12] = point(0.55, 0.35);
    image[23] = point(0.47, 0.6);
    image[24] = point(0.53, 0.6);
    image[15] = point(hx - 0.01, hy);
    image[16] = point(hx + 0.01, hy);
    return { index, timestampMs: t * 1000, detected: true, image, world: null, club: null };
  });

test("slow motion: impact is the bottom of the downswing, not the fast release after it", () => {
  const { phases, failure } = findSwingPhases(slowMotionSwing());
  assert.equal(failure, null);
  near(phases.impact?.timeMs, 4.6, 0.12, "impact");
  assert.ok(phases.delivery!.timeMs > 3400 && phases.delivery!.timeMs < phases.impact!.timeMs);
  near(phases.finish?.timeMs, 5.0, 0.25, "finish");
});

test("a pause at the top: top is where the downswing leaves, setup is back at address", () => {
  const { phases } = findSwingPhases(slowMotionSwing());
  near(phases.top?.timeMs, 3.4, 0.15, "top");
  near(phases.setup?.timeMs, 1.0, 0.15, "setup");
  assert.ok(phases.takeaway!.timeMs > phases.setup!.timeMs && phases.takeaway!.timeMs < 3000);
});
