import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

export default async function handler(req: Request, context: Context) {
  return handleBookingApiRoute(req, "/api/booking-confirmation-resend", context);
}

export const config: Config = {
  path: "/api/booking-confirmation-resend",
};
