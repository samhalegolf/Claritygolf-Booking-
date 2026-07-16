import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

const databaseAdapterBuild = "supabase-local-adapter-v7";

// This must stay a Netlify Functions v2 handler (a default export taking a
// Request). Netlify only applies `export const config.path` to v2 functions, so
// a legacy `export function handler(event)` here silently drops the /api/*
// routing and every route below falls through to the SPA catch-all redirect.
export default async function handler(req: Request, context: Context) {
  void databaseAdapterBuild;
  return handleBookingApiRoute(req, "", context);
}

// Every route below is owned by its own dedicated function. They must all be
// excluded here, otherwise this wildcard would shadow them.
export const config: Config = {
  path: "/api/*",
  excludedPath: [
    "/api/auth/login",
    "/api/auth/session",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/change-password",
    "/api/auth/logout",
    "/api/admin-settings",
    "/api/billing/*",
    "/api/billing-stripe-sync",
    "/api/stripe-billing-webhook",
    "/api/akahu-sync",
    "/api/booking-confirmation-resend",
    "/api/calendar-state",
    "/api/coaches",
    "/api/custom-group-confirm",
    "/api/google-calendar/*",
    "/api/google-calendar-sync",
    "/api/google-drive/*",
    "/api/locations",
    "/api/notes",
    "/api/notification-history",
    "/api/people",
    "/api/people/import",
    "/api/people/import-lite",
    "/api/people/migrate",
    "/api/public-booking",
    "/api/public-booking-catalog",
    "/api/public-booking-notifications",
    "/api/public-booking-slots",
    "/api/public-booking-state",
    "/api/public-calendar-invite",
    "/api/public-cancel",
    "/api/public-notification-status",
    "/api/public-reschedule",
    "/api/public-reschedule-lookup",
    "/api/public-reschedule/lookup",
    "/api/resend-webhook",
    "/api/system-smoke",
    "/api/test-email",
    "/api/video-transfer/*",
  ],
};
