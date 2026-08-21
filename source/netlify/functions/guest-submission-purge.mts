import type { Config } from "@netlify/functions";
import { purgeExpiredGuestSubmissions, purgeStaleGuestSenders } from "./video-transfer.mts";

// Retention for videos sent by people with no account.
//
// Until this existed, nothing in the system ever read cleanup_after -- it was
// written and forgotten, so "kept for 14 days" was a promise with no mechanism
// behind it. This is the mechanism.
//
// Runs on Netlify's scheduler, so it is not a public endpoint and nobody can
// trigger it over HTTP. The real work lives in video-transfer.mts because
// everything it needs (the Drive adapter, the token refresh, the session
// table) is private to that module -- same shape as akahu-poll delegating to
// _shared/akahu.

export default async function handler() {
  try {
    const videos = await purgeExpiredGuestSubmissions();
    const senders = await purgeStaleGuestSenders();
    if (videos.scanned || senders.removed) {
      console.log("guest_submission_purge:done", { ...videos, sendersRemoved: senders.removed });
    }
    return new Response("ok");
  } catch (error) {
    console.error(
      "guest_submission_purge:failed",
      error instanceof Error ? error.message : error,
    );
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  // Hourly, not daily.
  //
  // A 14-day retention window does not need hourly precision, and "0 4 * * *"
  // would be the tidier expression. But admin-notification-flush.mts records
  // that "* * * * *" demonstrably never fired in this deployment -- a queued
  // email sat unsent for 13 hours -- while "*/5" and akahu-poll's "0 * * * *"
  // run reliably. A retention job that silently never runs is the same class of
  // failure, and worse here because it fails open: videos just accumulate.
  // Take the schedule shape that is proven to fire in this account over the
  // elegant one. The cost of over-scheduling is one indexed query an hour that
  // usually returns nothing.
  schedule: "0 * * * *",
};
