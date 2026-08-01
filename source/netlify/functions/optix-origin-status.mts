import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

const SESSION_COOKIE = "clarity_session";

function env(name: string) {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseCookies(req: Request) {
  return Object.fromEntries((req.headers.get("cookie") || "").split(";").map((p) => p.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf("=");
    return i < 0 ? [decodeURIComponent(part), ""] : [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))];
  }));
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[SESSION_COOKIE] || "";
  if (!token) return false;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const rows = await getDatabase().sql`SELECT id FROM admin_sessions WHERE token_hash = ${tokenHash} AND expires_at > NOW() LIMIT 1`;
  return rows.length > 0;
}

async function supabaseRows() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  const select = "id,title,client,status,origin,external_booking_id,external_booking_session_id,external_resource_id,external_updated_at,external_sync_state";
  const response = await fetch(`${url}/rest/v1/calendar_items?origin=eq.optix&select=${select}&order=external_updated_at.desc.nullslast`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`Unable to read Optix-origin appointments (${response.status}).`);
  return response.json();
}

export default async function handler(req: Request) {
  if (!(await requireAdmin(req))) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const records = await supabaseRows();
    return json({ records });
  } catch (error) {
    return json({ error: "origin_status_failed", message: error instanceof Error ? error.message : "Unable to read Optix records." }, 500);
  }
}

export const config: Config = { path: "/api/optix-origin-status" };
