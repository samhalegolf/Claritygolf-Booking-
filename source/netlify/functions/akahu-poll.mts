import type { Config } from "@netlify/functions";
import { legacyOriginalWorkspaceId as defaultAccountId } from "./_shared/account.mts";
import { autoReconcileCredits, syncAkahuTransactions } from "./_shared/akahu.mts";

// Nightly safety net for the Akahu bank feed. Re-syncs the last ~10 days of
// transactions (covering anything a missed webhook didn't deliver) and
// auto-reconciles. Runs on Netlify's scheduler — it isn't a public endpoint, so
// no auth is needed; nobody can trigger it over HTTP.

// KNOWN BOUNDARY GAP, deliberately left for the Billing pass.
//
// There is no session here to resolve a business from, and the Akahu/Stripe
// credentials in the environment belong to the original workspace, so this
// still writes into legacyOriginalWorkspaceId(). That is correct while the
// original workspace is the only one with a bank or Stripe connection, and it
// is wrong the moment a second business connects one: their transactions would
// land in the first business's ledger.
//
// The fix is to resolve the business from the inbound payload -- the Akahu
// connection or the Stripe customer/subscription -- rather than statically.
// Until then, do not connect banking or Stripe for a second business.
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
  // Hourly. Akahu personal apps can't self-configure a real-time webhook, so a
  // frequent poll is how the feed stays effectively live (payments reconcile
  // within the hour). The 10-day re-sync window makes each run self-healing.
  schedule: "0 * * * *",
};
