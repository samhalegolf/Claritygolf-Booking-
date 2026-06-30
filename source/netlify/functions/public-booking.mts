import type { Config } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

export default async function handler(req: Request, context: unknown = null) {
  return handleBookingApiRoute(req, "/api/public-booking", context);
}

export const config: Config = { path: "/api/public-booking" };
