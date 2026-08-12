import type { Config } from "@netlify/functions";
import { processDueLessonReminders } from "./booking-core.mts";

// Scheduled sender for lesson reminder emails.
//
// Every 5 minutes it asks booking-core for appointments whose start time is
// inside the configured lead window (Settings → Email Notifications →
// "Lesson reminder") and emails the client, once per lesson. The
// notification_history row written by the send is the dedupe, so a run that
// dies mid-way simply leaves the rest for the next run. Exits cheaply (one
// settings read) while the feature is switched off.

export default async function handler() {
  try {
    const outcome = await processDueLessonReminders();
    if (outcome.due) console.log("lesson_reminders:done", outcome);
    return new Response("ok");
  } catch (error) {
    console.error("lesson_reminders:failed", error instanceof Error ? error.message : error);
    return new Response("error", { status: 500 });
  }
}

export const config: Config = {
  schedule: "*/5 * * * *",
};
