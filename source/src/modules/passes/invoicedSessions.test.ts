import { test } from "node:test";
import assert from "node:assert/strict";

import { invoicedSessions, lineSessions, lineWord, sessionWord } from "./invoicedSessions.ts";

test("a multi-unit line counts as its quantity, not as one line", () => {
  assert.equal(invoicedSessions([{ quantity: 3 }]), 3);
});

test("lines across several invoices add up", () => {
  assert.equal(invoicedSessions([{ quantity: 3 }, { quantity: 2 }, { quantity: 1 }]), 6);
});

test("nothing billed is nothing to compare against", () => {
  assert.equal(invoicedSessions([]), 0);
});

test("a line is never worth less than one session", () => {
  // Zero and part quantities arrive from synced invoices; a line that exists
  // was still billed for something, and rounding it to nothing would hide it.
  assert.equal(lineSessions({ quantity: 0 }), 1);
  assert.equal(lineSessions({ quantity: 0.4 }), 1);
  assert.equal(lineSessions({ quantity: Number.NaN }), 1);
});

test("part quantities round to whole sessions", () => {
  assert.equal(lineSessions({ quantity: 2.6 }), 3);
});

test("the words agree with the numbers", () => {
  assert.equal(sessionWord(1), "session");
  assert.equal(sessionWord(3), "sessions");
  assert.equal(lineWord(1), "line");
  assert.equal(lineWord(2), "lines");
});
