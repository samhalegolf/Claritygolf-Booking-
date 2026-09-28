import type { Config } from "@netlify/functions";

import { deliverDueWebhooks, processChangeLog, pruneEvents } from "./_shared/public-api/events.mts";

// Turns captured booking and client changes into API events, then sends the
// webhook deliveries that are due. Every minute, the shortest schedule Netlify
// runs, so a webhook lands within about a minute of the change.
export default async function handler() {
  try {
    const changes = await processChangeLog();
    const deliveries = await deliverDueWebhooks({ budgetMs: 22_000 });
    // Cheap, and once an hour is plenty.
    if (new Date().getUTCMinutes() === 7) await pruneEvents();
    if (changes.emitted || deliveries.sent || deliveries.failed) {
      console.log("api_webhook_worker:done", { ...changes, ...deliveries });
    }
    return new Response("ok");
  } catch (error) {
    console.error("api_webhook_worker:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  schedule: "* * * * *",
};
