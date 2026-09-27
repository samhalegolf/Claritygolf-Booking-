import type { Config } from "@netlify/functions";
import { flushAdminNotificationQueue } from "./booking-core.mts";

// Authoritative durable-notification worker. Calendar writes only settle a
// booking-scoped outbox job; this schedule atomically claims due jobs, records
// attempts, and retries failures. Browser flushes call the same worker only as
// an optional latency optimisation.

export default async function handler() {
  try {
    const { pending, results } = await flushAdminNotificationQueue();
    if (pending) {
      console.log("admin_notification_flush:done", {
        pending,
        sent: results.filter((entry: any) => entry?.status === "sent").length,
      });
    }
    return new Response("ok");
  } catch (error) {
    console.error("admin_notification_flush:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  // The existing two-minute Optix sweep is proven to run in this deployment.
  schedule: "*/2 * * * *",
};
