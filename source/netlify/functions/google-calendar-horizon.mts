import type { Config } from "@netlify/functions";
import { syncGoogleCalendarNow } from "./google-calendar-sync.mts";

// Nightly rebuild of the Google Calendar sync, for the one thing no edit can
// trigger: the passage of time.
//
// Unavailable blocks are published over a rolling twelve-week horizon measured
// from the current week. Every booking and availability change pushes its own
// sync, but nothing happens when a week simply rolls over — so without this the
// far edge of the horizon creeps closer until the calendar looks open months
// out, and last week's blocks linger with nothing to retire them.
//
// A full rebuild is what makes the run self-healing: the sync diffs its stored
// event map, so this both adds the week that came into range and deletes the
// one that fell out. Runs on Netlify's scheduler, not a public endpoint, so no
// auth is needed — nobody can trigger it over HTTP.

export default async function handler() {
  try {
    const result = await syncGoogleCalendarNow("scheduled_horizon_refresh");
    console.log("google_calendar_horizon:done", {
      ok: result?.ok !== false,
      skipped: result?.skipped === true,
      reason: result?.reason || "",
    });
    return new Response("ok");
  } catch (error) {
    console.error("google_calendar_horizon:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  // Daily, early morning UTC. The horizon only moves once a week, so this is
  // already far more often than it needs to be — the margin is there so a
  // single failed run never leaves the calendar wrong for a whole week.
  schedule: "17 3 * * *",
};
