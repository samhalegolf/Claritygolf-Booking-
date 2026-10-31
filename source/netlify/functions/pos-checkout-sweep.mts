import type { Config } from "@netlify/functions";

import { sweepPendingPosCheckouts } from "./billing-api.mts";

// The safety net under QR and online-shop payments.
//
// Every ten minutes: ask Stripe about each pending sale with a QR from the last
// two days and settle the ones that were paid. The till's poll and the Stripe
// webhook normally get there first; this catches what both missed (a till
// screen that went to sleep mid-Afterpay, a webhook that was failing). All of
// it is in sweepPendingPosCheckouts, and settling is safe to repeat.

export default async function handler() {
  try {
    const result = await sweepPendingPosCheckouts({ budgetMs: 20_000 });
    if (result.settled.length || result.needsAttention.length) console.log("pos_checkout_sweep:done", result);
    return new Response("ok");
  } catch (error) {
    console.error("pos_checkout_sweep:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  schedule: "*/10 * * * *",
};
