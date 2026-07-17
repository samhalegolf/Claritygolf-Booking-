import type { Config } from "@netlify/functions";
import { defaultAccountId } from "./_shared/account.mts";
import { autoReconcileCredits, syncAkahuTransactions } from "./_shared/akahu.mts";

// Nightly safety net for the Akahu bank feed. Re-syncs the last ~10 days of
// transactions (covering anything a missed webhook didn't deliver) and
// auto-reconciles. Runs on Netlify's scheduler — it isn't a public endpoint, so
// no auth is needed; nobody can trigger it over HTTP.

export default async function handler() {
  const accountId = defaultAccountId();
  const since = new Date(Date.now() - 10 * 86400000).toISOString();
  try {
    const transactions = await syncAkahuTransactions(accountId, since);
    const reconciled = await autoReconcileCredits(accountId);
    console.log("akahu_poll:done", { synced: transactions.synced, autoApplied: reconciled.autoApplied });
    return new Response("ok");
  } catch (error) {
    console.error("akahu_poll:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  // ~03:00 NZ (15:00 UTC) daily.
  schedule: "0 15 * * *",
};
