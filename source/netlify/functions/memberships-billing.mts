import type { Config } from "@netlify/functions";

import { runDueMemberships } from "./_shared/memberships.mts";

// The recurring payments engine's clock.
//
// Every ten minutes: raise the billing periods that have started, charge saved
// cards for them, retry cards that failed (1, 3 and 5 days later), and finish
// memberships that were cancelled or reached the end of their term. All of it
// is in _shared/memberships.mts; each membership is worked under a short lock,
// so an overlapping run, a coach pressing Retry and a webhook cannot charge
// the same period twice.
//
// A new period is only started while the run is young: one Stripe charge can
// take several seconds, and the function has to finish inside its own limit.
// Anything left over is picked up ten minutes later.

export default async function handler() {
  try {
    const result = await runDueMemberships({ budgetMs: 15_000 });
    if (result.due || result.abandoned) console.log("memberships_billing:done", result);
    return new Response("ok");
  } catch (error) {
    console.error("memberships_billing:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  schedule: "*/10 * * * *",
};
