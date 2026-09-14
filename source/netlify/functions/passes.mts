import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

/**
 * Passes -- the coach's side: read what a person holds, grant credits, void.
 *
 * Its own function rather than a route on the wildcard for the same reason
 * practice-blocks is: a profile opens this on every visit, and a dedicated
 * function keeps that off the shared booking-api instance.
 */
export default async function handler(req: Request, context: Context) {
  return handleBookingApiRoute(req, "/api/passes", context);
}

export const config: Config = {
  path: "/api/passes",
};
