import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import { bookOneResource } from "./_shared/optix-book-resource.mts";

const SESSION_COOKIE = "clarity_session";

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

function parseCookies(req: Request) {
  return Object.fromEntries(
    (req.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[SESSION_COOKIE] || "";
  if (!token) return false;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const rows = await db().sql`
    SELECT id
    FROM admin_sessions
    WHERE token_hash = ${tokenHash}
      AND expires_at > NOW()
    LIMIT 1
  `;
  return rows.length > 0;
}

export default async function handler(req: Request) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

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
    const result = await bookOneResource(calendarItemId);
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
