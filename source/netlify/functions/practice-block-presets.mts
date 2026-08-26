import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

/**
 * Practice block presets -- the coach's saved templates, plus the "used often"
 * suggestions derived from their assignment history. Coach-only; the player
 * portal never sees either.
 *
 * The collection path carries list/save/rename-and-reorder/delete. /dismiss is
 * its own path because it writes a preference rather than a preset, and is
 * resolved here rather than left to the router -- Netlify may hand this
 * handler its own /.netlify/functions/ form and the two must stay
 * distinguishable.
 */
export default async function handler(req: Request, context: Context) {
  const pathname = new URL(req.url).pathname;
  const route = pathname.endsWith("/dismiss")
    ? "/api/practice-block-presets/dismiss"
    : "/api/practice-block-presets";
  return handleBookingApiRoute(req, route, context);
}

export const config: Config = {
  path: ["/api/practice-block-presets", "/api/practice-block-presets/dismiss"],
};
