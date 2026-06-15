import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

const databaseAdapterBuild = "supabase-local-adapter-v3";

export default async (req: Request, context: Context) => {
  void databaseAdapterBuild;
  return handleBookingApiRoute(req, "", context);
};

export const config: Config = {
  path: "/api/*",
  excludedPath: [
    "/api/public-booking-state",
    "/api/public-notification-status",
    "/api/public-booking",
    "/api/public-reschedule",
    "/api/public-reschedule-lookup",
    "/api/public-reschedule/lookup",
    "/api/people/migrate",
  ],
};
