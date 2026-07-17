import type { Config } from "@netlify/functions";
import { flushAdminNotificationQueue } from "./booking-core.mts";

// Server-side safety net for the admin notification debounce queue.
//
// Admin booking changes (drag reschedules, edits, new bookings entered by the
// coach) are debounced for 30 seconds before their emails send. Until this
// function existed, the only things that flushed that queue were the *next*
// calendar save or a setTimeout in the admin's open browser tab — so closing
// the laptop within ~30 seconds of a reschedule meant the client's email sat
// unsent until the coach next opened the app, and was often dropped entirely
// by the staleness checks when it finally flushed. Live notification_history
// showed 2 reschedule emails ever sent against ~100 bookings/cancellations.
//
// Runs every minute on Netlify's scheduler; not a public endpoint, no auth
// surface. Exits cheaply (one settings read) when the queue is empty.

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
  schedule: "* * * * *",
};
