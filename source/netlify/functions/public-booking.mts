import type { Config } from "@netlify/functions";

import { handlePublicBookingRequest } from "./booking-core.mts";

export default async function handler(req: Request, context: unknown = null) {
  return handlePublicBookingRequest(req, context);
}

export const config: Config = { path: "/api/public-booking" };
