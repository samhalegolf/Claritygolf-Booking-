import type { Config } from "@netlify/functions";

import { handlePublicBookingStateRequest } from "./booking-core.mts";

function withPublicReadCache(response: Response) {
  const headers = new Headers(response.headers);
  if (response.ok) {
    headers.set(
      "Netlify-CDN-Cache-Control",
      "public, durable, max-age=20, stale-while-revalidate=60",
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
  return withPublicReadCache(await handlePublicBookingStateRequest());
}

export const config: Config = { path: "/api/public-booking-state" };
