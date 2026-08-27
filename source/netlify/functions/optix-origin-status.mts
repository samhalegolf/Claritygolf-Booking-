import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";


function env(name: string) {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The old check proved a session row existed and nothing more, while the query
 * below read every business's Optix bookings -- client names included.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
}

async function supabaseRows(accountId: string) {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  const select = "id,title,client,status,origin,external_booking_id,external_booking_session_id,external_resource_id,external_updated_at,external_sync_state";
  const response = await fetch(
    `${url}/rest/v1/calendar_items?origin=eq.optix&account_id=eq.${encodeURIComponent(accountId)}` +
      `&select=${select}&order=external_updated_at.desc.nullslast`,
    {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    },
  );
  if (!response.ok) throw new Error(`Unable to read Optix-origin appointments (${response.status}).`);
  return response.json();
}

export default async function handler(req: Request) {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const accountId = await requireAccountId(req);
    const records = await supabaseRows(accountId);
    return json({ records });
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return json(
        {
          error: (error as { code?: string })?.code || "unauthorized",
          message: error instanceof Error ? error.message : "Admin login required.",
        },
        status,
      );
    }
    return json({ error: "origin_status_failed", message: error instanceof Error ? error.message : "Unable to read Optix records." }, 500);
  }
}

export const config: Config = { path: "/api/optix-origin-status" };
