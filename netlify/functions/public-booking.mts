import type { Config, Context } from "@netlify/functions";

import { handlePublicBookingRequest } from "./booking-core.mts";

export default async (req: Request, context: Context) => handlePublicBookingRequest(req, context);

export const config: Config = {
  path: "/api/public-booking",
};
