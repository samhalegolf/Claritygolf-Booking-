import { test } from "node:test";
import assert from "node:assert/strict";

import { formatClock, parseClock } from "./clock";

test("formatClock", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(75.9), "1:15");
  assert.equal(formatClock(-3), "0:00");
});

test("parseClock reads seconds, m:ss and h:mm:ss, and refuses the rest", () => {
  assert.equal(parseClock("75"), 75);
  assert.equal(parseClock("1:15"), 75);
  assert.equal(parseClock("1:02:03"), 3723);
  assert.equal(parseClock(" 0:05 "), 5);
  assert.equal(parseClock(""), null);
  assert.equal(parseClock("1:75"), null);
  assert.equal(parseClock("abc"), null);
});
