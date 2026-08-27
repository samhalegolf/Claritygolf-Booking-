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
// for the original workspace, nothing more.

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

/** The original workspace's account id. For migrations/backfill ONLY. */
export const LEGACY_DEFAULT_ACCOUNT_ID = "sam-hale-golf";

/**
 * The original workspace's account id for migration/backfill use only.
 * NOT for runtime authorization paths.
 */
export function legacyOriginalWorkspaceId(): string {
  return LEGACY_DEFAULT_ACCOUNT_ID;
}

/**
 * Validates and slugifies an account id without falling back to legacy id.
 * Returns empty string if the input is invalid.
 */
export function slugifyAccountId(value: unknown): string {
  return slugify(value, "");
}

/** The public calendar slug. For original workspace bootstrapping only. */
export function defaultCalendarSlug(): string {
  return slugify(env("CLARITY_CALENDAR_SLUG"), "") || legacyOriginalWorkspaceId();
}
