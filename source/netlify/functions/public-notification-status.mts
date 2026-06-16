import type { Config } from "@netlify/functions";

import { handlePublicNotificationStatusRequest } from "./booking-core.mts";

export default async (req: Request) => handlePublicNotificationStatusRequest(req);

export const config: Config = {
  path: "/api/public-notification-status",
};
