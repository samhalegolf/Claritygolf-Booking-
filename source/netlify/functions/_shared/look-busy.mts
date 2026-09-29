// Booking page › Look busy.
//
// With it on, the public page offers only the times that sit flush against
// something: the start or end of the coach's window, or either side of a
// booking or block already in their day. A free morning offers its first and
// last lesson rather than every half hour, and a booking at 10 offers the
// lessons either side of it, so the day fills from its edges and never ends up
// with an hour's gap between two lessons.
//
// Isomorphic: the booking server uses it to build the public slots and the
// coach app uses it for the Booking page preview, so the two cannot drift. It
// only lists candidates; each still has to pass the caller's own free-time
// checks.

export type BusyRange = { start: number; end: number };

/** Candidate start times, earliest first, for one availability window. */
export function lookBusyStarts(
  window: { start: number; end: number },
  duration: number,
  busy: BusyRange[],
): number[] {
  const edges = [window.start, window.end - duration];
  for (const range of busy) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) continue;
    edges.push(range.end, range.start - duration);
  }
  return [...new Set(edges)]
    .filter((start) => start >= window.start && start + duration <= window.end)
    .sort((a, b) => a - b);
}
