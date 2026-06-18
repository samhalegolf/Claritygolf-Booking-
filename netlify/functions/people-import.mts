import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default async (req: Request, context: Context) => {
  try {
    // Keep this route separate from the broad /api/* function so Netlify sends
    // the request to the protected import handler, but do not run raw SQL here.
    // The Netlify database adapter used by the app exposes SQL through the
    // booking-core db() helper, not getDatabase().pool.query.
    return await handleBookingApiRoute(req, "/api/people/import", context);
  } catch (error) {
    const message = error instanceof Error ? error.message : "People import failed.";
    console.error("people_import_failed", error);
    return json({ error: "people_import_failed", message }, 500);
  }
};

export const config: Config = {
  path: "/api/people/import",
};
