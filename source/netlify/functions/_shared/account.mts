// The workspace account id, in one place.
//
// "sam-hale-golf" used to appear as a literal fallback in 22 places across the
// functions and the frontend. Any code path whose settings lookup came back
// empty silently adopted it — so a second coach's records could be written under
// the first coach's account id, and their calendar would show someone else's
// lessons.
//
// The literal survives here, exactly once, because it is not arbitrary: it is
// the real account id already stamped on every existing person and calendar item
// in production. Changing it would orphan that data. It is the migration default
// for the original workspace, nothing more — set CLARITY_COACH_ACCOUNT_ID and
// the entire app follows, with no code change.

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

export function slugify(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

/** The original workspace's account id. Do not reuse as a generic default. */
export const LEGACY_DEFAULT_ACCOUNT_ID = "sam-hale-golf";

/** The account id every workspace-scoped read and write should fall back to. */
export function defaultAccountId(): string {
  return (
    slugify(env("CLARITY_COACH_ACCOUNT_ID"), "") || LEGACY_DEFAULT_ACCOUNT_ID
  );
}

/** The public calendar slug. Falls back to the account id. */
export function defaultCalendarSlug(): string {
  return slugify(env("CLARITY_CALENDAR_SLUG"), "") || defaultAccountId();
}
