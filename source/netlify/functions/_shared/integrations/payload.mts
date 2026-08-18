/**
 * Reading values out of an inbound webhook payload, whoever sent it.
 *
 * Nothing here knows about a particular provider. Booking systems post payloads
 * whose field names vary by event type and drift between versions (member.email
 * vs member_email vs email, for one), so rather than each provider adapter
 * inventing its own defensive lookup, they all read through these four.
 *
 * A provider adapter's job is to say *which* paths to try. This file's job is
 * to try them without throwing.
 */

export function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

/** The first path that resolves to a non-empty value, else "". */
export function pick(payload: any, ...paths: string[]) {
  for (const path of paths) {
    const value = path.split(".").reduce((item, key) => item?.[key], payload);
    if (value !== undefined && value !== null && text(value)) return value;
  }
  return "";
}

/**
 * An ISO timestamp from either a unix epoch (seconds or milliseconds, which is
 * what most booking systems send) or a parseable date string. "" when the value
 * is unusable, so callers decide whether a missing time is fatal.
 */
export function iso(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const numeric = Number(raw);
  const date = Number.isFinite(numeric) && /^\d+$/.test(raw)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

/**
 * A money amount in minor units (cents).
 *
 * Providers disagree about how to send money, so this accepts both shapes
 * every billing API uses: an integer in minor units (`amount_cents: 4500`) and
 * a decimal major amount (`amount: "45.00"`). A value with a decimal point, or
 * a field named for major units, is treated as major; a bare integer in a
 * *_cents/minor field is treated as already-minor. Returns null when absent.
 */
export function amountInCents(value: unknown, isMinorUnitField = false) {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw.replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  if (isMinorUnitField && !raw.includes(".")) return Math.round(numeric);
  return Math.round(numeric * 100);
}
