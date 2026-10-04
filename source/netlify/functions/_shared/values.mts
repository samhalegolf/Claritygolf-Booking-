import { legacyOriginalWorkspaceId } from "./account.mts";

/**
 * Small value helpers every part of the booking API leans on: trimming
 * strings, slugs, emails, URLs, safe JSON and reading environment variables.
 *
 * Nothing here knows about bookings, clients or businesses. Anything that does
 * belongs in the domain module for it.
 */

export function timeToMinutes(hour, minute) {
  return hour * 60 + minute;
}

export function env(name, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

export function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeJsonStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      const asNumber = Number(current);
      return Number.isSafeInteger(asNumber) ? asNumber : String(current);
    }
    if (current && typeof current === "object") {
      if (seen.has(current)) return "[Circular]";
      seen.add(current);
    }
    return current;
  });
}

export function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function cleanPositiveInteger(value, fallback, min = 1, max = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.round(parsed)))
    : fallback;
}

export function cleanString(value, fallback = "", max = 600) {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

export function cleanSlug(value, fallback = legacyOriginalWorkspaceId()) {
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

export function cleanEmail(value, fallback = "") {
  const email = cleanString(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
}

export function cleanUrl(value, fallback) {
  const raw = cleanString(value, "", 600);
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}
