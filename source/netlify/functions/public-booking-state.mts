import type { Config } from "@netlify/functions";

import { handlePublicBookingStateRequest } from "./booking-core.mts";
import { withPublicReadCache } from "./_shared/public-read-cache.mts";

export default async function handler(req: Request) {
  return withPublicReadCache(req, await handlePublicBookingStateRequest(req), { maxAge: 20, staleWhileRevalidate: 60 });
}

export const config: Config = { path: "/api/public-booking-state" };
