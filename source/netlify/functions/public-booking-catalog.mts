import type { Config } from "@netlify/functions";

import { handlePublicBookingCatalogRequest } from "./booking-core.mts";

export default async function handler() {
  return handlePublicBookingCatalogRequest();
}

export const config: Config = { path: "/api/public-booking-catalog" };
