import type { Config } from "@netlify/functions";

import { handlePublicBookingNotificationsRequest } from "./calendar-state.mts";

export default async function handler(req: Request) {
  return handlePublicBookingNotificationsRequest(req);
}

export const config: Config = {
  path: "/api/public-booking-notifications",
};
