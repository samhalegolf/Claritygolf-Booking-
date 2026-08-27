import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import { bookOneResource } from "./_shared/optix-book-resource.mts";
import { requireCoachActor } from "./_shared/coach-auth.mts";


function db() {
  return getDatabase();
}

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
 * Booking an Optix resource acts on one Clarity booking by id. The old check
 * proved only that a session row existed, and readAppointment then took the
 * account from whatever row that id found -- so a signed-in coach could book a
 * bay against another business's lesson just by knowing its id.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let accountId = "";
  try {
    accountId = await requireAccountId(req);
  } catch (error) {
    const status = (error as { status?: number })?.status === 403 ? 403 : 401;
    return json(
      {
        error: (error as { code?: string })?.code || "unauthorized",
        message: error instanceof Error ? error.message : "Admin login required.",
      },
      status,
    );
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const calendarItemId = String(body?.calendarItemId || "").trim();
  const source = String(body?.source || "").trim();
  if (!calendarItemId || source !== "manual-book-resource") {
    return json(
      {
        ok: false,
        error: "manual_booking_required",
        message: "Optix resource bookings can only be created from the Book resource button on a Clarity booking card.",
      },
      400,
    );
  }

  try {
    const result = await bookOneResource(accountId, calendarItemId);
    return json(result, result.ok ? 200 : 207);
  } catch (error: any) {
    const code = String(error?.code || "optix_reconcile_failed");
    return json(
      {
        ok: false,
        error: code,
        message: error instanceof Error ? error.message : "Optix resource booking failed.",
      },
      code === "not_configured" ? 503 : 500,
    );
  }
}

export const config: Config = { path: "/api/optix-booking-reconcile" };
