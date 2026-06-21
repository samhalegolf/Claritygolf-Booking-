import type { Config } from "@netlify/functions";

import { handlePublicBookingNotificationsRequest } from "./booking-core.mts";

export default async (req: Request) => handlePublicBookingNotificationsRequest(req);

export const config: Config = {
  path: "/api/public-booking-notifications",
};
