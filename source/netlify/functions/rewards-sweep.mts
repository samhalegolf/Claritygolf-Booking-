import type { Config } from "@netlify/functions";

import { runAllRewards } from "./_shared/rewards.mts";

// The rewards programme's clock.
//
// Every thirty minutes: recount each live programme's activity and pay any
// reward that has been earned and not yet paid. All of it is in
// _shared/rewards.mts, and every reward is keyed so that this run, an
// overlapping one and a coach pressing Run now can never pay the same one
// twice. Accounts left over when the budget runs out are picked up next time.

export default async function handler() {
  try {
    const result = await runAllRewards({ budgetMs: 15_000 });
    if (result.rewards) console.log("rewards_sweep:done", result);
    return new Response("ok");
  } catch (error) {
    console.error("rewards_sweep:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  schedule: "*/30 * * * *",
};
