import type { Config } from "@netlify/functions";

import { handlePublicRescheduleLookupRequest } from "./booking-core.mts";

export default async (req: Request) => handlePublicRescheduleLookupRequest(req);

export const config: Config = {
  path: "/api/public-reschedule-lookup",
};
