// Who gets the developer tools: the diagnostics panel, the Google Calendar
// debug log, the Putting Lab and video debug overlays.
//
// Not a workspace role. Roles live in each business's settings, which that
// business's admins can edit; this is decided here from the signed-in email
// and an env var, so nothing a business does can grant it.
//
// CLARITY_DEVELOPER_EMAILS is a comma-separated list. Unset means nobody.

export function isDeveloperEmail(email: unknown) {
  if (typeof email !== "string" || !email.trim()) return false;
  const target = email.trim().toLowerCase();
  // process.env, not values.mts's env(): this file is reached from the app's
  // type check through auth-contract, and values.mts is untyped.
  return (process.env.CLARITY_DEVELOPER_EMAILS || "")
    .split(",")
    .some((entry) => entry.trim().toLowerCase() === target);
}
