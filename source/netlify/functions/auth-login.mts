import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

export default async function handler(req: Request, context: Context) {
  return handleBookingApiRoute(req, "/api/auth/login", context);
}

export const config: Config = {
  path: "/api/auth/login",
};
