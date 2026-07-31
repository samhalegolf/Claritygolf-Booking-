import type { Config } from "@netlify/functions";

import { reconcileOptixBookings } from "./optix-booking-reconcile.mts";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Immediate event-driven Optix sync endpoint.
 *
 * Booking mutations call this route after the Clarity booking has been saved.
 * The scheduled reconcile function remains only as the 30-minute safety audit.
 */
export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    const result = await reconcileOptixBookings();
    return json(result, result.ok ? 200 : 207);
  } catch (error: any) {
    const code = String(error?.code || "optix_reconcile_failed");
    return json(
      {
        ok: false,
        error: code,
        message:
          error instanceof Error ? error.message : "Optix reconciliation failed.",
        tokenExpired: code === "token_expired",
      },
      code === "not_configured" ? 503 : 500,
    );
  }
}

export const config: Config = {
  path: "/api/optix-booking-reconcile",
};
