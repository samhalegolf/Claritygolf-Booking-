/**
 * The coach calendar's first read, started from boot alongside the session
 * check instead of after it.
 *
 * Without this, GET /api/calendar-state waited for /api/auth/session to answer,
 * then for App to mount, before it was even sent -- and the Today list is the
 * page's largest paint. boot.tsx starts it for a returning coach (the same hint
 * that warms the client list); the workspace's first hydration takes the
 * response once. A Response body can only be read once, so it is handed out a
 * single time and anything older than MAX_AGE_MS is ignored in favour of a
 * fresh read.
 *
 * If the session turns out to be gone, the prefetch simply answers 401 and is
 * never taken -- the login screen does not mount the workspace.
 */

const MAX_AGE_MS = 30_000;

let pending: { startedAt: number; response: Promise<Response> } | null = null;

export function prefetchCalendarState() {
  if (pending) return;
  const response = fetch("/api/calendar-state", { headers: { Accept: "application/json" } });
  // Nobody may ever take it; an unclaimed network failure must not surface as
  // an unhandled rejection. The taker still sees the rejection.
  response.catch(() => undefined);
  pending = { startedAt: Date.now(), response };
}

/** The prefetched response, once, if it is recent enough; otherwise null. */
export function takePrefetchedCalendarState(): Promise<Response> | null {
  const current = pending;
  pending = null;
  if (!current || Date.now() - current.startedAt > MAX_AGE_MS) return null;
  return current.response;
}
