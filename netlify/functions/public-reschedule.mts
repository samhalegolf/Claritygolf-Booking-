import type { Config, Context } from "@netlify/functions";

import { handlePublicRescheduleRequest } from "./booking-core.mts";

export default async (req: Request, context: Context) => handlePublicRescheduleRequest(req, context);

export const config: Config = {
  path: "/api/public-reschedule",
};
