import type { Config } from "@netlify/functions";
import { sweepQueuedAutoBooks } from "./_shared/optix-book-resource.mts";

// Scheduled catch-up for Optix bay auto-booking.
//
// A lesson on a lesson type with Auto-book ticked gets a 'pending' row in
// optix_booking_sync the moment it is saved (queueAutoBookResource). The save
// then tries to book the bay in the background, which usually lands within
// seconds -- and, when the background task is cut short, silently does not.
// Every two minutes this picks up the rows nothing answered and books them
// through the same path the Book bay button uses, so a lesson never sits with
// no bay and no record of why.
//
// One row per run, plus more only while the run is still young: a single
// Optix attempt may take 25 seconds, and the function has to finish inside its
// own limit. A quiet calendar costs one small query per run.

export default async function handler() {
  try {
    const outcome = await sweepQueuedAutoBooks({ budgetMs: 4_000 });
    if (outcome.claimed) console.log("optix_auto_book_sweep:done", outcome);
    return new Response("ok");
  } catch (error) {
    console.error("optix_auto_book_sweep:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  schedule: "*/2 * * * *",
};
