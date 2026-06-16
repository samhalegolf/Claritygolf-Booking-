import type { Config } from "@netlify/functions";

import { handleCalendarFeedRequest } from "./booking-core.mts";

export default async (req: Request) => {
  const debug = new URL(req.url).searchParams.get("debug");
  if (debug === "ping") {
    return new Response("calendar-feed-ok", {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return handleCalendarFeedRequest(req);
};

export const config: Config = {
  path: "/calendar/*",
};
