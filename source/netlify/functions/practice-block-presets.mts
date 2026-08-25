import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

/**
 * Practice block presets -- the coach's saved templates, plus the "used often"
 * suggestions derived from their assignment history. Coach-only; the player
 * portal never sees either.
 *
 * One path, three methods (list, save, delete), so unlike practice-blocks.mts
 * there is nothing to disambiguate here.
 */
export default async function handler(req: Request, context: Context) {
  return handleBookingApiRoute(req, "/api/practice-block-presets", context);
}

export const config: Config = {
  path: "/api/practice-block-presets",
};
