/**
 * Reading values out of an Optix webhook payload.
 *
 * Optix posts form-encoded webhooks whose field names vary by event type and
 * have changed shape between events we have seen (member.email vs member_email
 * vs email, for one). Rather than each consumer inventing its own defensive
 * lookup, both the booking path and the pass-purchase path read through these.
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
 * what Optix sends) or a parseable date string. "" when the value is unusable,
 * so callers decide whether a missing time is fatal.
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
 * Optix has not been observed sending money yet, so this accepts both shapes
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
