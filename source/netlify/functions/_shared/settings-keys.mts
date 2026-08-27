// Settings keys that must never ride along on a bulk `key,value` read.
//
// `settings` is a key/value table that every request path reads in full to get
// its config (servicesJson, coachProfilesJson, locationsJson, availabilityJson —
// about 3.5 kB between them). Measured on production: that read was shipping
// 68 kB and taking ~706 ms, against a ~217 ms floor for a trivial query in the
// same region, and it runs ~2,000 times a day. The database itself answers in
// 0.14 ms; the cost is entirely payload on the wire.
//
// Half of those 68 kB was googleCalendarDebugLogJson — a 30-entry ring buffer
// of Google API request/response bodies, capped at 220 kB, written for the sync
// diagnostics panel and read by exactly one function. Every booking, every
// email send and every session check was paying to transfer a debug log.
//
// Anything listed here is still readable by key. google-calendar-sync fetches
// it directly when it needs it (readSettingMap there is deliberately unfiltered);
// nothing else ever touched it.
//
// Rule of thumb for adding to this list: the key is large, and only one code
// path reads it. If several paths need it, fix the storage instead — see
// brandLogoPreview, which is 16 kB of base64 image sitting in this table and is
// genuinely read by the branding paths, so it can't simply be excluded. That
// one needs the logo served from its own endpoint by URL.
export const BULK_EXCLUDED_SETTING_KEYS = ["googleCalendarDebugLogJson"];

// The exclusion on its own, for callers composing it with an account filter
// (see _shared/settings-scope.mts).
export const SETTINGS_BULK_EXCLUDE_FILTER =
  `key=not.in.(${BULK_EXCLUDED_SETTING_KEYS.join(",")})`;

// PostgREST query for a bulk settings read with the heavy keys left behind.
export const SETTINGS_BULK_SELECT_QUERY = `select=key,value&${SETTINGS_BULK_EXCLUDE_FILTER}`;
