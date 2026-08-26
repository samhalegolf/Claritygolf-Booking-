import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

/**
 * The account's practice block types -- the kinds a coach can assign, with
 * their names, colours and which composer fields each one offers.
 *
 * Account config, read whole and written whole, so one path and two methods.
 * The composer never calls this: it gets the list free with its starters
 * request. This is the settings screen's route.
 */
export default async function handler(req: Request, context: Context) {
  return handleBookingApiRoute(req, "/api/practice-block-types", context);
}

export const config: Config = {
  path: "/api/practice-block-types",
};
