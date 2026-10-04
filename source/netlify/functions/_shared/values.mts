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

/** env() with surrounding whitespace removed: for keys and URLs pasted into Netlify. */
export function trimmedEnv(name, fallback = "") {
  return String(env(name, fallback)).trim();
}

export function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * JSON.stringify that cannot throw on what a database hands back: a bigint
 * becomes a number (or a string when it would lose precision), and a real
 * cycle becomes "[Circular]".
 *
 * Only a real cycle -- an object inside itself. The same object appearing
 * twice side by side (one slot list under two keys) is ordinary data and is
 * written out both times.
 */
export function safeJsonStringify(value) {
  // The objects on the path from the root to the value being written. JSON
  // calls the replacer with `this` set to the parent, so the path is trimmed
  // back to that parent before each check.
  const path = [];
  return JSON.stringify(value, function (_key, current) {
    if (typeof current === "bigint") {
      const asNumber = Number(current);
      return Number.isSafeInteger(asNumber) ? asNumber : String(current);
    }
    if (path.length) {
      const parentAt = path.indexOf(this);
      if (parentAt === -1) path.push(this);
      else path.length = parentAt + 1;
      if (current && typeof current === "object" && path.includes(current)) return "[Circular]";
    } else {
      path.push(current);
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

/**
 * Like cleanString, but a blank string also falls back. Use it where an empty
 * value means "not given" (a title, a name on an email) rather than "cleared".
 */
export function cleanText(value, fallback = "", max = 600) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
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
