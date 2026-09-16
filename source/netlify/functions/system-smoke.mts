import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { deliverEmail } from "./_shared/email-delivery.mts";
import {
  SETTINGS_UPSERT_QUERY,
  settingsSelectQuery,
  settingsUpsertRows,
} from "./_shared/settings-scope.mts";


function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function checkStep(name: string, fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    return { name, ok: true, value };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function checkOptixOrganizationCapabilities() {
  const token = env("OPTIX_ORGANIZATION_TOKEN").trim();
  const endpoint = env("OPTIX_GRAPHQL_ENDPOINT", "https://api.optixapp.com/graphql").trim();
  if (!token) throw new Error("OPTIX_ORGANIZATION_TOKEN is not configured.");
  const query = `query { me { capabilities(capabilities_to_check: ["authenticated", "manage", "bookings"]) } }`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: {} }),
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {
    httpStatus: response.status,
    capabilities: payload?.data?.me?.capabilities || [],
    errors: Array.isArray(payload?.errors)
      ? payload.errors.map((error: any) => ({
          message: String(error?.message || ""),
          code: String(error?.extensions?.code || error?.extensions?.errorCode || ""),
        }))
      : [],
  };
}

/**
 * The email step of the smoke test.
 *
 * Goes through the same deliverEmail() every real send uses, so a pass means
 * the path production takes works -- a hand-rolled fetch here could pass while
 * the actual sender was broken. `fromName` is the one legitimate override in the
 * app: this email is from Clarity, not from the coach's business.
 */
async function sendSmokeEmail(accountId: string, to: string) {
  const result = await deliverEmail({
    accountId,
    to,
    subject: "Clarity booking smoke test",
    text: `Smoke test accepted by the booking app at ${nowIso()}.`,
    fromName: "Clarity Golf Booking",
    idempotencyKey: `smoke-${Date.now()}`,
  });
  if (!result.sent) {
    throw new Error(`Email send failed (${result.reason}): ${(result.error || "").slice(0, 500)}`);
  }
  return { id: result.id || "" };
}

export default async function handler(req: Request) {
  try {
    // The smoke test writes a row, so it runs inside the caller's own business
    // rather than against the table at large.
    const accountId = (await requireCoachActor(req)).accountId;
    const url = new URL(req.url);
    const smokeId = `smoke-${randomUUID()}`;
    const accountFilter = `account_id=eq.${encodeURIComponent(accountId)}`;
    const steps = [
      await checkStep("supabase_settings_read", () =>
        supabase("settings", { query: settingsSelectQuery(accountId, { filters: ["limit=1"] }) }),
      ),
      await checkStep("supabase_calendar_read", () => supabase("calendar_items", { query: `select=id&${accountFilter}&limit=1` })),
      await checkStep("supabase_people_read", () => supabase("people", { query: `select=id&${accountFilter}&limit=1` })),
      await checkStep("supabase_notifications_read", () => supabase("notification_history", { query: `select=id&${accountFilter}&limit=1` })),
      await checkStep("supabase_settings_write", () =>
        supabase("settings", {
          method: "POST",
          query: SETTINGS_UPSERT_QUERY,
          prefer: "resolution=merge-duplicates,return=minimal",
          body: settingsUpsertRows(accountId, { systemSmokeLastRun: smokeId }, nowIso()),
        }),
      ),
      await checkStep("optix_organization_capabilities", () => checkOptixOrganizationCapabilities()),
    ];
    const emailTo = url.searchParams.get("email");
    if (emailTo) steps.push(await checkStep("resend_send", () => sendSmokeEmail(accountId, emailTo)));
    else steps.push({ name: "resend_config", ok: Boolean(env("RESEND_API_KEY")), value: env("RESEND_API_KEY") ? "configured" : "missing" });

    return json({ ok: steps.every((step) => step.ok), checkedAt: nowIso(), steps });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Smoke test failed." }, 500);
  }
}

export const config: Config = { path: "/api/system-smoke" };
