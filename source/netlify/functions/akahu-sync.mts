import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { listAkahuAccounts, syncAkahuTransactions } from "./_shared/akahu.mts";
import { json } from "./_shared/http.mts";

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
      return json({ accounts: await listAkahuAccounts(accountId) });
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
    return json({
        error: (error as { code?: string })?.code || "akahu_sync_error",
        message: error instanceof Error ? error.message : "Sync failed." ,
      }, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);
  }
}

export const config: Config = {
  path: "/api/akahu-sync",
};
