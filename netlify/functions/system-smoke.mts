import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import { supabaseEnvStatus, supabaseRequest } from "./supabase-client.mjs";

const sessionCookieName = "clarity_session";
function env(name: string, fallback = "") { return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
function nowIso() { return new Date().toISOString(); }
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(cookieHeaderValue.split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const index = pair.indexOf("=");
    return index === -1 ? [decodeURIComponent(pair), ""] : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
  }));
}
async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabaseRequest("admin_sessions", { purpose: "Supabase smoke test", query: `select=id&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(nowIso())}&limit=1` });
  return rows.length > 0;
}
async function checkStep(name: string, fn: () => Promise<unknown>) {
  try { return { name, ok: true, value: await fn() }; }
  catch (error) { return { name, ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
async function sendSmokeEmail(to: string) {
  const apiKey = env("RESEND_API_KEY");
  const from = env("CLARITY_EMAIL_FROM", "Clarity Golf Booking <bookings@claritygolf.app>");
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to, subject: "Clarity booking smoke test", text: `Smoke test accepted by the booking app at ${nowIso()}.` }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Resend failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export default async function handler(req: Request) {
  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required.", supabaseEnv: supabaseEnvStatus() }, 401);
    const url = new URL(req.url);
    const smokeId = `smoke-${randomUUID()}`;
    const supabaseEnv = supabaseEnvStatus();
    const steps = [
      { name: "supabase_env", ok: supabaseEnv.SUPABASE_URL && (supabaseEnv.SUPABASE_SERVICE_ROLE_KEY || supabaseEnv.SUPABASE_SERVICE_KEY), value: supabaseEnv },
      await checkStep("supabase_settings_read", () => supabaseRequest("settings", { purpose: "Supabase smoke test", query: "select=key,value&limit=1" })),
      await checkStep("supabase_calendar_read", () => supabaseRequest("calendar_items", { purpose: "Supabase smoke test", query: "select=id&limit=1" })),
      await checkStep("supabase_people_read", () => supabaseRequest("people", { purpose: "Supabase smoke test", query: "select=id&limit=1" })),
      await checkStep("supabase_notifications_read", () => supabaseRequest("notification_history", { purpose: "Supabase smoke test", query: "select=id&limit=1" })),
      await checkStep("supabase_settings_write", () => supabaseRequest("settings", { purpose: "Supabase smoke test", method: "POST", query: "on_conflict=key", prefer: "resolution=merge-duplicates,return=minimal", body: [{ key: "systemSmokeLastRun", value: smokeId, updated_at: nowIso() }] })),
    ];
    const emailTo = url.searchParams.get("email");
    if (emailTo) steps.push(await checkStep("resend_send", () => sendSmokeEmail(emailTo)));
    else steps.push({ name: "resend_config", ok: Boolean(env("RESEND_API_KEY")), value: env("RESEND_API_KEY") ? "configured" : "missing" });
    return json({ ok: steps.every((step) => step.ok), checkedAt: nowIso(), steps });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Smoke test failed.", supabaseEnv: supabaseEnvStatus() }, 500);
  }
}

export const config: Config = { path: "/api/system-smoke" };
