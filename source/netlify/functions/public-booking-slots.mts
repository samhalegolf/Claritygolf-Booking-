import type { Config } from "@netlify/functions";

import { handlePublicBookingSlotsRequest } from "./booking-core.mts";
import { withPublicReadCache } from "./_shared/public-read-cache.mts";

export default async function handler(req: Request) {
  return withPublicReadCache(req, await handlePublicBookingSlotsRequest(req), { maxAge: 15, staleWhileRevalidate: 45 });
}

export const config: Config = { path: "/api/public-booking-slots", region: "syd" };
