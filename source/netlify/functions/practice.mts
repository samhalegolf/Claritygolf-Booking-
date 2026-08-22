import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

/**
 * Prescribed practice, and the category library the titles come from.
 *
 * Two paths through one function. The pathname is resolved here rather than
 * left to the router, because Netlify may hand this handler its own
 * /.netlify/functions/ form and the two routes have to stay distinguishable.
 */
export default async function handler(req: Request, context: Context) {
  const pathname = new URL(req.url).pathname;
  const route = pathname.endsWith("/categories") ? "/api/practice/categories" : "/api/practice";
  return handleBookingApiRoute(req, route, context);
}

export const config: Config = {
  path: ["/api/practice", "/api/practice/categories"],
};
