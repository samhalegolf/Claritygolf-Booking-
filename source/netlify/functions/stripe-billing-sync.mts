import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { DEFAULT_SINCE_EPOCH, syncChargesSince, syncInvoicesSince } from "./_shared/stripe-billing.mts";

// Admin backfill endpoint: pulls Stripe invoices and charges (card payments
// from the booking site) into the billing tables. Safe to re-run — everything
// upserts on Stripe ids. Live updates arrive separately via
// stripe-billing-webhook.mts; this endpoint is the manual catch-up/backfill.
//
// Products are NOT pulled — see _shared/stripe-billing.mts for why.
//
// POST /api/billing-stripe-sync
//   { action?: "syncAll" | "syncInvoices" | "syncCharges",
//     since?: string | number }   // since "all" (or 0) backfills full history


function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Same session check as billing-api.mts.
/**
 * The business this sync writes into.
 *
 * It used to mirror billing-api's old settings-driven resolution -- and, like
 * that one, always answered with the original business. Stripe invoices and
 * charges land in whichever business the caller administers, resolved the same
 * way every other private route resolves it.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
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

// Optional upper bound so a big backfill can be run in date windows that each
// finish inside the function timeout. undefined = no upper bound (up to now).
function normaliseUntil(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber);
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return undefined;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST only." }, 405);

  try {
    const accountId = await requireAccountId(req);

    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const action = String(body?.action || "syncAll");

    const until = normaliseUntil(body?.until);
    if (action === "syncInvoices") {
      return json({ invoices: await syncInvoicesSince(normaliseSince(body?.since), accountId, until) });
    }
    if (action === "syncCharges") {
      return json({ charges: await syncChargesSince(normaliseSince(body?.since), accountId, until) });
    }
    // "syncProducts" is gone on purpose: it imported every Stripe product ever
    // created into the catalog. See _shared/stripe-billing.mts. It is answered
    // rather than 400'd so an old bookmark gets an explanation.
    if (action === "syncProducts") {
      return json({
        error: "products_not_synced",
        message: "Stripe products are no longer imported. Products are managed in Billing > Products.",
      }, 410);
    }
    if (action === "syncAll") {
      const since = normaliseSince(body?.since);
      const invoices = await syncInvoicesSince(since, accountId, until);
      const charges = await syncChargesSince(since, accountId, until);
      return json({ ok: invoices.ok && charges.ok, invoices, charges });
    }

    return json({ error: "unknown_action", message: "Unknown billing sync action." }, 400);
  } catch (error) {
    console.error("stripe_billing_sync:failed", error);
    const status = Number((error as { status?: unknown })?.status);
    return json(
      {
        error: (error as { code?: string })?.code || "stripe_billing_sync_error",
        message: error instanceof Error ? error.message : "Sync failed.",
      },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = {
  path: "/api/billing-stripe-sync",
};
