import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

export default async (req: Request, context: Context) => {
  return handleBookingApiRoute(req, "/api/test-email", context);
};

export const config: Config = {
  path: "/api/test-email",
};
