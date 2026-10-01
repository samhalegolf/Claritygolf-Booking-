import assert from "node:assert/strict";
import { test } from "node:test";

import type { ObservationFrame } from "../observe/observation";
import { secondAngleFrameAt } from "./secondAngleSync";

const clip = (count: number, stepMs: number): ObservationFrame[] =>
  Array.from({ length: count }, (_, index) => ({
    index,
    timestampMs: index * stepMs,
    detected: true,
    image: null,
    world: null,
    club: null,
  })) as unknown as ObservationFrame[];

test("without a usable fusion the clips are shown from their own starts", () => {
  const raw = clip(10, 100);
  assert.equal(secondAngleFrameAt(320, raw, null)?.index, 3);
  assert.equal(
    secondAngleFrameAt(320, raw, { usable: false, rate: 2, offsetMs: 500 })?.index,
    3
  );
});

test("a usable fusion moves the second clip by its measured offset and rate", () => {
  const raw = clip(20, 100);
  assert.equal(secondAngleFrameAt(300, raw, { usable: true, rate: 1, offsetMs: 400 })?.index, 7);
  assert.equal(secondAngleFrameAt(300, raw, { usable: true, rate: 2, offsetMs: 0 })?.index, 6);
});

test("no frame before the second clip starts or after it stops", () => {
  const raw = clip(10, 100);
  assert.equal(secondAngleFrameAt(0, raw, { usable: true, rate: 1, offsetMs: -500 }), null);
  assert.equal(secondAngleFrameAt(900, raw, { usable: true, rate: 1, offsetMs: 500 }), null);
  assert.equal(secondAngleFrameAt(0, [], null), null);
});
