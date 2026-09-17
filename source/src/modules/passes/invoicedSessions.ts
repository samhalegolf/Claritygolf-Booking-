// Counting what a client was actually billed for.
//
// An invoice line is not a session. One line reading "Lesson × 3" is three
// lessons sold, and the pass beside it holds three credits, so counting lines
// says "invoiced for 1" against "3 given" and invents a discrepancy that is not
// there. The number a coach compares against credits is the quantity, summed.
//
// Kept out of the panel, like invoiceMath and stockMath, because it is the
// arithmetic the screen's claim rests on and it is worth testing on its own.

/** Only the part of an invoice line this arithmetic needs. */
export type CountableLine = { quantity: number };

/** One line's own session count: whole units, never less than one. */
export function lineSessions(line: CountableLine) {
  return Math.max(1, Math.round(Number(line.quantity) || 0));
}

/** How many sessions a set of invoice lines adds up to. */
export function invoicedSessions(lines: CountableLine[]) {
  return (lines || []).reduce((total, line) => total + lineSessions(line), 0);
}

export function sessionWord(count: number) {
  return count === 1 ? "session" : "sessions";
}

export function lineWord(count: number) {
  return count === 1 ? "line" : "lines";
}
