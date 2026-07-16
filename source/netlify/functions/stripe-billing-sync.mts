import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import { defaultAccountId } from "./_shared/account.mts";
import { DEFAULT_SINCE_EPOCH, syncAllProducts, syncChargesSince, syncInvoicesSince } from "./_shared/stripe-billing.mts";

// Admin backfill endpoint: pulls Stripe invoices, charges (card payments from
// the booking site) and ALL Stripe products into the billing tables. Safe to
// re-run — everything upserts on Stripe ids. Live updates arrive separately via
// stripe-billing-webhook.mts; this endpoint is the manual catch-up/backfill.
//
// POST /api/billing-stripe-sync
//   { action?: "syncAll" | "syncInvoices" | "syncCharges" | "syncProducts",
//     since?: string | number }   // since "all" (or 0) backfills full history

const sessionCookieName = "clarity_session";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeaderValue
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
}

// Same session check as billing-api.mts.
async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) return false;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const response = await fetch(
    `${url}/rest/v1/admin_sessions?select=id&token_hash=eq.${encodeURIComponent(tokenHash)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) return false;
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

// Mirrors billing-api.mts's account resolution (settings-driven with the
// shared fallback), without importing booking code.
async function resolveAccountId() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) return defaultAccountId();
  try {
    const response = await fetch(
      `${url}/rest/v1/settings?select=key,value&key=in.(accountCalendarSlug,accountBusinessName,coachName)`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!response.ok) return defaultAccountId();
    const rows = (await response.json()) as { key: string; value: string }[];
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const businessName = map.accountBusinessName || map.coachName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf");
    const slugSource = map.accountCalendarSlug || businessName;
    const slug = String(slugSource)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || defaultAccountId();
  } catch {
    return defaultAccountId();
  }
}

function normaliseSince(value: unknown) {
  if (value === undefined || value === null || value === "") return DEFAULT_SINCE_EPOCH;
  // "all" / 0 → full history from the epoch (first backfill of pre-2026 rows).
  if (String(value).trim().toLowerCase() === "all") return 0;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.floor(asNumber);
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return DEFAULT_SINCE_EPOCH;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST only." }, 405);

  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    const accountId = await resolveAccountId();

    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const action = String(body?.action || "syncAll");

    if (action === "syncInvoices") {
      return json({ invoices: await syncInvoicesSince(normaliseSince(body?.since), accountId) });
    }
    if (action === "syncCharges") {
      return json({ charges: await syncChargesSince(normaliseSince(body?.since), accountId) });
    }
    if (action === "syncProducts") {
      return json({ products: await syncAllProducts(accountId) });
    }
    if (action === "syncAll") {
      const since = normaliseSince(body?.since);
      const products = await syncAllProducts(accountId);
      const invoices = await syncInvoicesSince(since, accountId);
      const charges = await syncChargesSince(since, accountId);
      return json({ ok: products.ok && invoices.ok && charges.ok, products, invoices, charges });
    }

    return json({ error: "unknown_action", message: "Unknown billing sync action." }, 400);
  } catch (error) {
    console.error("stripe_billing_sync:failed", error);
    const status = Number((error as { status?: unknown })?.status);
    return json(
      { error: "stripe_billing_sync_error", message: error instanceof Error ? error.message : "Sync failed." },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = {
  path: "/api/billing-stripe-sync",
};
