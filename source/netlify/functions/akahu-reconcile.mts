import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import {
  applyReconciliation,
  autoReconcileCredits,
  ignoreReconcileCandidate,
  listReconcileCandidates,
} from "./_shared/akahu.mts";

// Phase 3 of the Akahu bank feed: native payment reconciliation. Matches
// money-in bank transactions to open invoices and marks them paid LOCALLY only
// — it never calls Stripe. Admin-only.
//
// POST /api/akahu-reconcile
//   { action: "list" }                       -> credits + suggested invoice matches
//   { action: "auto" }                       -> apply every unambiguous match
//   { action: "apply", id, invoiceId }       -> confirm one match
//   { action: "ignore", id }                 -> dismiss a credit (not a payment)


function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function cleanId(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST only." }, 405);

  try {
    // Bank feeds, expenses and reconciliation are per business. This used to
    // check only that a session existed and then act on the original
    // workspace regardless of who was signed in.
    const accountId = (await requireCoachActor(req)).accountId;

    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const action = String(body?.action || "list");

    if (action === "list") {
      return json({ candidates: await listReconcileCandidates(accountId) });
    }
    if (action === "auto") {
      return json(await autoReconcileCredits(accountId));
    }
    if (action === "apply") {
      const id = cleanId(body?.id);
      const invoiceId = cleanId(body?.invoiceId);
      if (!id || !invoiceId) return json({ error: "bad_request", message: "Missing transaction or invoice id." }, 400);
      return json(await applyReconciliation(accountId, id, invoiceId));
    }
    if (action === "ignore") {
      const id = cleanId(body?.id);
      if (!id) return json({ error: "bad_request", message: "Missing transaction id." }, 400);
      return json(await ignoreReconcileCandidate(accountId, id));
    }

    return json({ error: "unknown_action", message: "Unknown reconcile action." }, 400);
  } catch (error) {
    console.error("akahu_reconcile:failed", error);
    const status = Number((error as { status?: unknown })?.status);
    return json(
      {
        error: (error as { code?: string })?.code || "akahu_reconcile_error",
        message: error instanceof Error ? error.message : "Request failed." ,
      },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = {
  path: "/api/akahu-reconcile",
};
