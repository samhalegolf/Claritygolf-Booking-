import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

/**
 * The coach calendar must use the same storage, concurrency and notification
 * pipeline as public bookings. Keeping a second direct-Supabase implementation
 * here caused duplicate people rows, inconsistent auth and missed emails.
 */
export default async (req: Request, context: Context) => {
  return handleBookingApiRoute(req, "/api/calendar-state", context);
};

export const config: Config = {
  path: "/api/calendar-state",
};
