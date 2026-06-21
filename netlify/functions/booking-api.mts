import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

const databaseAdapterBuild = "supabase-local-adapter-v7";

export default async (req: Request, context: Context) => {
  void databaseAdapterBuild;
  return handleBookingApiRoute(req, "", context);
};

export const config: Config = {
  path: "/api/*",
  excludedPath: [
    "/api/auth/login",
    "/api/auth/session",
    "/api/auth/logout",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/calendar-state",
    "/api/admin-settings",
    "/api/notification-history",
    "/api/test-email",
    "/api/system-smoke",
    "/api/public-booking-state",
    "/api/public-notification-status",
    "/api/public-booking",
    "/api/public-reschedule",
    "/api/public-reschedule-lookup",
    "/api/public-reschedule/lookup",
    "/api/people/migrate",
  ],
};
