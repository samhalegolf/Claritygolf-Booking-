import type { Config } from "@netlify/functions";

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
 * Compatibility endpoint retained so older callers receive an explicit answer.
 *
 * Automatic/bulk Clarity -> Optix reconciliation is intentionally disabled.
 * Resource bookings may only be created through the admin booking card's
 * explicit Book resource action handled by optix-booking-reconcile.mts.
 */
export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  return json(
    {
      ok: false,
      error: "manual_booking_required",
      message:
        "Automatic Optix reconciliation is disabled. Use Book resource on the Clarity booking card.",
    },
    409,
  );
}

export const config: Config = {
  path: "/api/optix-booking-trigger",
};
