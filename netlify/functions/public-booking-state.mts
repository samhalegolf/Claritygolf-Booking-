import type { Config } from "@netlify/functions";

import { handlePublicBookingStateRequest } from "./booking-core.mts";

export default async (req: Request) => {
  const debug = new URL(req.url).searchParams.get("debug");
  if (debug === "ping") {
    return new Response(JSON.stringify({ ok: true, function: "public-booking-state" }), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return handlePublicBookingStateRequest();
};

export const config: Config = {
  path: "/api/public-booking-state",
};
