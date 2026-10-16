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

// Every route below is owned by its own dedicated function (a different
// handler, a pinned region, or a schedule). They must all be excluded here,
// otherwise this wildcard would shadow them. Routes the core router serves
// itself -- auth, people, coaches, locations, notes, passes, practice blocks --
// used to have one-line wrapper functions of their own; each was another copy
// of the core to cold-start, so the wildcard serves them now.
export const config: Config = {
  path: "/api/*",
  excludedPath: [
    "/api/auth/session",
    "/api/admin-settings",
    "/api/billing/*",
    "/api/billing-stripe-sync",
    "/api/stripe-billing-webhook",
    "/api/stripe-connect/*",
    "/api/akahu-sync",
    "/api/akahu-expenses",
    "/api/akahu-reconcile",
    "/api/akahu-webhook",
    "/api/calendar-state",
    "/api/custom-group-confirm",
    "/api/external-bookings",
    "/api/google-calendar/*",
    "/api/google-calendar-sync",
    "/api/google-drive/*",
    "/api/integration-setup",
    "/api/optix-origin-status",
    "/api/optix-booking-type-settings",
    "/api/optix-webhook",
    "/api/memberships",
    "/api/memberships/plans",
    "/api/memberships/enrol",
    "/api/memberships/action",
    "/api/memberships/charge",
    "/api/memberships/card-link",
    "/api/memberships/checkout/return",
    "/api/rewards",
    "/api/rewards/programs",
    "/api/rewards/run",
    "/api/people/migrate",
    "/api/resource-hold",
    "/api/resource-status",
    "/api/resource-webhook",
    "/api/resource-webhook-settings",
    "/api/public-booking",
    "/api/public-booking-catalog",
    "/api/public-booking-slots",
    "/api/public-booking-state",
    "/api/public-calendar-invite",
    "/api/public-cancel",
    "/api/public-notification-status",
    "/api/public-reschedule",
    "/api/public-reschedule-lookup",
    "/api/push-subscriptions",
    "/api/resend-webhook",
    "/api/system-smoke",
    "/api/test-email",
    "/api/video-transfer/*",
    "/api/camera-terminal",
    "/api/camera-terminal/*",
    // Clarity's public API. Its own function: _shared/public-api/.
    "/api/v1",
    "/api/v1/*",
    "/api/api-access",
  ],
};