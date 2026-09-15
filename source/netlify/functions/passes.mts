import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

/**
 * Passes -- the coach's side: read what a person holds, grant credits, void,
 * and work the inbox of passes nobody has claimed.
 *
 * Its own function rather than a route on the wildcard for the same reason
 * practice-blocks is: a profile opens this on every visit, and a dedicated
 * function keeps that off the shared booking-api instance.
 *
 * Three paths through one function, resolved here by suffix rather than by
 * passing the raw pathname through. Netlify may hand this handler its own
 * /.netlify/functions/passes form, which carries none of the routes -- reading
 * the URL straight would send every one of them to the bare /api/passes
 * branch, and the inbox would silently answer with somebody's balances.
 */
export default async function handler(req: Request, context: Context) {
  const pathname = new URL(req.url).pathname;
  const route = pathname.endsWith("/inbox")
    ? "/api/passes/inbox"
    : pathname.endsWith("/attach")
      ? "/api/passes/attach"
      : "/api/passes";
  return handleBookingApiRoute(req, route, context);
}

export const config: Config = {
  // Each path spelled out rather than "/api/passes/*": the wildcard would also
  // claim routes nobody has written yet, and a typo would be answered by this
  // function instead of falling through to a 404 that says so.
  path: ["/api/passes", "/api/passes/inbox", "/api/passes/attach"],
};
