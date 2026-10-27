import type { Config } from "@netlify/functions";

import { handlePublicBookingCatalogRequest } from "./booking-core.mts";
import { withPublicReadCache } from "./_shared/public-read-cache.mts";

export default async function handler(req: Request) {
  return withPublicReadCache(req, await handlePublicBookingCatalogRequest(req), { maxAge: 60, staleWhileRevalidate: 300 });
}

export const config: Config = { path: "/api/public-booking-catalog", region: "syd" };
