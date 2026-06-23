import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

export default async function handler(req: Request, context: Context) {
  return handleBookingApiRoute(req, "/api/public-booking-notifications", context);
}

export const config: Config = {
  path: "/api/public-booking-notifications",
};
