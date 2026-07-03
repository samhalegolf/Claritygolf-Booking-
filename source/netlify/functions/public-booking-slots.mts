import type { Config } from "@netlify/functions";

import { handlePublicBookingSlotsRequest } from "./booking-core.mts";

function withPublicReadCache(response: Response) {
  const headers = new Headers(response.headers);
  if (response.ok) {
    headers.set(
      "Netlify-CDN-Cache-Control",
      "public, durable, max-age=15, stale-while-revalidate=45",
    );
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default async function handler(req: Request) {
  return withPublicReadCache(await handlePublicBookingSlotsRequest(req));
}

export const config: Config = { path: "/api/public-booking-slots" };
