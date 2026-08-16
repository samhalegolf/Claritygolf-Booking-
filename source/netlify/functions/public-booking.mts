import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

// Public booking submissions from the booking page.
//
// This used to be a standalone reimplementation (`public-booking.ts`, logged as
// `public_booking_lean:*`) with its own Supabase REST client, written to keep
// this route off the large booking-core bundle. It saved the appointment but
// never sent the client's confirmation email: the only Resend call in it was a
// fallback alert to the coach when the *save* failed. Combined with the browser
// no longer calling /api/public-booking-notifications, that left public booking
// confirmations with no trigger at all — bookings landed on the calendar and the
// client heard nothing.
//
// createPublicBooking() in booking-core already sends the confirmation
// server-side (schedulePublicBookingSideEffects, guarded by a
// notification_history check so retries can't double-send), so this route now
// delegates there rather than keeping a second copy of the booking rules.
//
// It stays a dedicated function rather than falling through to booking-api's
// /api/* wildcard so this route keeps its own lambda and its own warm instance.
export default async function handler(req: Request, context: Context) {
  return handleBookingApiRoute(req, "/api/public-booking", context);
}

export const config: Config = {
  path: "/api/public-booking",
};
