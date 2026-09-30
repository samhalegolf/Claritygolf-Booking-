import assert from "node:assert/strict";
import test from "node:test";

import { cleanCameras, cleanPairCode, isTerminalOnline, newPairCode, newTerminalCode } from "../camera-terminal.mts";

test("a terminal's credential is long, lowercase and free of look-alike characters", () => {
  const codes = new Set(Array.from({ length: 200 }, () => newTerminalCode()));
  assert.equal(codes.size, 200, "codes must not repeat");
  for (const code of codes) {
    assert.match(code, /^[a-z2-9]{32}$/);
    assert.doesNotMatch(code, /[ilo01]/);
  }
});

test("a pairing code is six easy-to-read characters", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = newPairCode();
    assert.match(code, /^[a-z2-9]{6}$/);
    assert.doesNotMatch(code, /[ilo01]/);
  }
});

test("a pairing code is read however the coach typed it", () => {
  assert.equal(cleanPairCode("K7M 4QP"), "k7m4qp");
  assert.equal(cleanPairCode(" k7m-4qp "), "k7m4qp");
  assert.equal(cleanPairCode(undefined), "");
});

test("a terminal is online only while its heartbeat is fresh", () => {
  const now = Date.parse("2026-09-30T10:00:00Z");
  assert.equal(isTerminalOnline("2026-09-30T09:59:55Z", now), true);
  assert.equal(isTerminalOnline("2026-09-30T09:59:40Z", now), false);
  assert.equal(isTerminalOnline(null, now), false);
  assert.equal(isTerminalOnline("not a date", now), false);
});

test("a terminal reports at most two cameras, one per side of compare", () => {
  const cameras = cleanCameras([{ label: "Face on" }, { label: "Down the line" }, { label: "Overhead" }]);
  assert.deepEqual(cameras, [{ label: "Face on" }, { label: "Down the line" }]);
  assert.deepEqual(cleanCameras([{}]), [{ label: "Camera" }]);
  assert.deepEqual(cleanCameras("nonsense"), []);
});
