import type { Config } from "@netlify/functions";

import { handleCalendarFeedRequest } from "./booking-core.mts";

export default async function handler(req: Request) {
  // Kept from the previous wrapper: a way to confirm the feed is reachable
  // without handing out a calendar to do it.
  if (new URL(req.url).searchParams.get("debug") === "ping") {
    return new Response("calendar-feed-ok", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  return handleCalendarFeedRequest(req);
}

export const config: Config = {
  path: "/calendar/*",
};
