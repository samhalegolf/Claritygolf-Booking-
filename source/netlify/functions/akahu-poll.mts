import type { Config } from "@netlify/functions";
import { legacyOriginalWorkspaceId } from "./_shared/account.mts";
import { autoReconcileCredits, syncAkahuTransactions } from "./_shared/akahu.mts";
import { accountsWithStoredCredentials } from "./_shared/integration-credentials.mts";

// Hourly safety net for the Akahu bank feed. Re-syncs the last ~10 days of
// transactions (covering anything a missed webhook didn't deliver) and
// auto-reconciles. Runs on Netlify's scheduler — it isn't a public endpoint, so
// no auth is needed; nobody can trigger it over HTTP.
//
// Once per business with a bank feed, each on its own tokens and into its own
// ledger. That is every business that saved Akahu credentials, plus the
// original workspace, whose feed still comes from the AKAHU_* env vars (it
// simply reports "not connected" and is skipped when those are unset). One
// business's failure is logged and does not stop the next one's sync.
export default async function handler() {
  const since = new Date(Date.now() - 10 * 86400000).toISOString();
  const stored = await accountsWithStoredCredentials("akahu").catch(() => [] as string[]);
  const accounts = Array.from(new Set([legacyOriginalWorkspaceId(), ...stored]));
  let failed = 0;
  for (const accountId of accounts) {
    try {
      const transactions = await syncAkahuTransactions(accountId, since);
      const reconciled = await autoReconcileCredits(accountId);
      console.log("akahu_poll:done", { accountId, synced: transactions.synced, autoApplied: reconciled.autoApplied });
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status);
      // 503 is "this business has no bank feed", which is not a failure.
      if (status === 503) continue;
      failed += 1;
      console.error("akahu_poll:failed", accountId, error instanceof Error ? error.message : error);
    }
  }
  return new Response(failed ? "partial" : "ok", { status: failed ? 500 : 200 });
}

export const config: Config = {
  // Hourly. Akahu personal apps can't self-configure a real-time webhook, so a
  // frequent poll is how the feed stays effectively live (payments reconcile
  // within the hour). The 10-day re-sync window makes each run self-healing.
  schedule: "0 * * * *",
};
