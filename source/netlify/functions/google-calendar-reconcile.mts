import type { Config } from "@netlify/functions";
import { syncGoogleCalendarNow } from "./google-calendar-sync.mts";

// Nightly reconciliation of the Google Calendar sync.
//
// Every booking and availability change pushes its own sync, but a push that
// fails — a Google 5xx, a token refresh that blips, a function that times out
// mid-run — is never retried by anything. The calendar then stays wrong until
// the next unrelated edit happens to touch the same event, which may be never.
//
// A full rebuild is what makes this self-healing rather than just another push:
// the sync diffs its stored event map against what should exist, so it creates
// what is missing, updates what drifted and deletes what should be gone. A run
// with nothing to fix costs almost nothing, because unchanged events are
// short-circuited on their fingerprint.
//
// This used to exist to walk a rolling horizon of unavailable blocks forward.
// Those are weekly recurring events now and cover every hour indefinitely, so
// there is no horizon left to roll — but the reconciliation is worth keeping on
// its own account.
//
// Runs on Netlify's scheduler, not a public endpoint, so no auth is needed:
// nobody can trigger it over HTTP.

export default async function handler() {
  try {
    const result = await syncGoogleCalendarNow("scheduled_reconcile");
    console.log("google_calendar_reconcile:done", {
      ok: result?.ok !== false,
      skipped: result?.skipped === true,
      reason: result?.reason || "",
    });
    return new Response("ok");
  } catch (error) {
    console.error("google_calendar_reconcile:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  // Daily, early morning UTC — quiet enough that a rebuild never collides with
  // someone editing the calendar.
  schedule: "17 3 * * *",
};
