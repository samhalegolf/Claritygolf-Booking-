import type { Config } from "@netlify/functions";

import { handlePublicBookingSlotsRequest } from "./booking-core.mts";

export default async function handler(req: Request) {
  return handlePublicBookingSlotsRequest(req);
}

export const config: Config = { path: "/api/public-booking-slots" };
