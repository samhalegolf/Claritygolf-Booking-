// Who gets the developer tools: the diagnostics panel, the Google Calendar
// debug log, the Putting Lab and video debug overlays.
//
// Not a workspace role. Roles live in each business's settings, which that
// business's admins can edit; this is decided here from the signed-in email
// and an env var, so nothing a business does can grant it.
//
// CLARITY_DEVELOPER_EMAILS is a comma-separated list. Unset means nobody.

import { env } from "./values.mts";

export function isDeveloperEmail(email: unknown) {
  if (typeof email !== "string" || !email.trim()) return false;
  const target = email.trim().toLowerCase();
  return String(env("CLARITY_DEVELOPER_EMAILS", ""))
    .split(",")
    .some((entry: string) => entry.trim().toLowerCase() === target);
}
