import type { Config } from "@netlify/functions";

import { handlePublicBookingCatalogRequest } from "./booking-core.mts";

function withPublicReadCache(response: Response) {
  const headers = new Headers(response.headers);
  if (response.ok) {
    headers.set(
      "Netlify-CDN-Cache-Control",
      "public, durable, max-age=60, stale-while-revalidate=300",
    );
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default async function handler() {
  return withPublicReadCache(await handlePublicBookingCatalogRequest());
}

export const config: Config = { path: "/api/public-booking-catalog" };
