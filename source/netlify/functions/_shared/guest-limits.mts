// What someone with no account is allowed to spend of the coach's Drive.
//
// Shared by video-transfer.mts (which enforces them) and booking-core.mts
// (which reports them back to the app so it can say "2 of 3 sent" before the
// player runs into a 429). They live here rather than in either file so the
// two can never drift apart.
//
// A guest credential is minted by anyone who can type a name and an email, so
// it is bounded three ways: what one guest may send ever; how fast the account
// as a whole can absorb strangers; and how many stranger bytes may sit in the
// coach's Drive at once.
//
// The third is the one that actually protects them. A guest allowance is
// 3 x 150 MB = 450 MB, and retention is 14 days, so the steady-state resident
// footprint of a burst cap alone is roughly dailyCap x 14 x avgSize -- at 25/day
// and a realistic 40 MB phone video that is ~14 GB, which already exceeds a free
// 15 GB Drive shared with the coach's own transfers. A rate cap bounds a burst;
// a resident-bytes cap bounds the bill. Every value is env-overridable so a
// coach on paid storage can raise the ceiling without a deploy.

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per video. Also keeps the share page's range-sliced download tractable. */
export const guestSubmissionMaxBytes = numberFromEnv(
  "CLARITY_GUEST_MAX_BYTES",
  150 * 1024 * 1024,
);

/**
 * Per guest sender. Not per day -- but read the counting rule before assuming
 * "lifetime" is literal: guestSubmissionCount excludes cancelled, failed and
 * expired rows, so in practice this is "how many they may have live at once".
 *
 * Both exclusions are deliberate. A dropped connection must not silently burn
 * one of someone's three attempts, and a guest whose videos aged out after a
 * coach never looked should be able to try again rather than being locked out
 * forever by a slow reply. What stops that being a slow-drip abuse channel is
 * not this number -- it is the two account-wide caps below.
 */
export const guestSubmissionsLifetime = numberFromEnv("CLARITY_GUEST_LIFETIME_SENDS", 3);

/** How long an unclaimed guest video survives before the purge job deletes it. */
export const guestRetentionDays = numberFromEnv("CLARITY_GUEST_RETENTION_DAYS", 14);

/** Burst brake across the whole account. 25 strangers in a day is already an event. */
export const guestSubmissionsPerAccountPerDay = numberFromEnv(
  "CLARITY_GUEST_ACCOUNT_SENDS_PER_DAY",
  25,
);

/** The real bound: unclaimed guest bytes resident in the coach's Drive. */
export const guestResidentBytesPerAccount = numberFromEnv(
  "CLARITY_GUEST_RESIDENT_BYTES",
  8 * 1024 * 1024 * 1024,
);

/** A row is cheap; the expensive cap lives on the upload path above. */
export const guestRegistrationsPerAccountPerDay = numberFromEnv(
  "CLARITY_GUEST_REGISTRATIONS_PER_DAY",
  100,
);
