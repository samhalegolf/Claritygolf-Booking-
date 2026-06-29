import type { Config } from "@netlify/functions";

import { handlePublicBookingStateRequest } from "./booking-core.mts";

export default async function handler(req: Request) {
  return handlePublicBookingStateRequest();
}

export const config: Config = { path: "/api/public-booking-state" };
