import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { listAkahuAccounts, syncAkahuTransactions } from "./_shared/akahu.mts";

// Admin backfill / poll endpoint for the Akahu bank feed: pulls transactions
// from the connected Akahu accounts into bank_transactions. Safe to re-run —
// everything upserts on the Akahu transaction id. Live updates arrive
// separately via akahu-webhook.mts (later phase); this endpoint is the manual
// backfill and the nightly-poll safety net.
//
// POST /api/akahu-sync  { action?: "sync" | "accounts", since?: string }
//   since: ISO date-time (exclusive start); omit for all available history.


function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Same session check as billing-api.mts / stripe-billing-sync.mts.
export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST only." }, 405);

  try {
    // Bank feeds, expenses and reconciliation are per business. This used to
    // check only that a session existed and then act on the original
    // workspace regardless of who was signed in.
    const accountId = (await requireCoachActor(req)).accountId;

    const raw = await req.text();
    const body = raw ? JSON.parse(raw) : {};
    const action = String(body?.action || "sync");

    if (action === "accounts") {
      return json({ accounts: await listAkahuAccounts() });
    }
    if (action === "sync") {
      const since = typeof body?.since === "string" && body.since.trim() ? body.since.trim() : undefined;
      const until = typeof body?.until === "string" && body.until.trim() ? body.until.trim() : undefined;
      return json({ transactions: await syncAkahuTransactions(accountId, since, until) });
    }

    return json({ error: "unknown_action", message: "Unknown Akahu sync action." }, 400);
  } catch (error) {
    console.error("akahu_sync:failed", error);
    const status = Number((error as { status?: unknown })?.status);
    return json(
      {
        error: (error as { code?: string })?.code || "akahu_sync_error",
        message: error instanceof Error ? error.message : "Sync failed." ,
      },
      Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    );
  }
}

export const config: Config = {
  path: "/api/akahu-sync",
};
