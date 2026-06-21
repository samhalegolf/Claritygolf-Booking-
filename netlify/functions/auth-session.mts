import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

export default async (req: Request, context: Context) => {
  return handleBookingApiRoute(req, "/api/auth/session", context);
};

export const config: Config = {
  path: "/api/auth/session",
};
