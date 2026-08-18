import { text } from "./payload.mts";

/**
 * Supabase access and person identity for everything any integration writes.
 *
 * Provider-neutral on purpose. Every adapter — inbound bookings, purchases,
 * whatever a future provider sends — writes through the same client and
 * resolves people through the same matcher, so identity rules can't drift
 * apart one provider at a time.
 *
 * These live here rather than beside a provider's ingest code so two paths can
 * share them without importing each other.
 */

type SupabaseConfig = { url: string; key: string };

function env(name: string) {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function config(): SupabaseConfig {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw Object.assign(new Error("Supabase is not configured."), { code: "not_configured" });
  return { url, key };
}

export async function integrationRequest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const message = body?.message || body?.error || `Supabase request failed (${response.status}).`;
    throw Object.assign(new Error(message), { code: body?.code || "supabase_error", status: response.status });
  }
  return body;
}

export type ExternalPersonCandidate = { id?: unknown; name?: unknown; email?: unknown; phone?: unknown };

export function rowsOf(value: unknown): ExternalPersonCandidate[] {
  return Array.isArray(value) ? value : [];
}

function uniqueById(rows: ExternalPersonCandidate[]) {
  const seen = new Map<string, ExternalPersonCandidate>();
  for (const row of rows) {
    const id = text(row?.id);
    if (id && !seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()];
}

/**
 * Identity matching for anything arriving from an external provider is
 * deliberately one-sided, and matches on email alone.
 *
 * A duplicate person is always recoverable — the new record lands in the
 * external booking clients list, where an admin merges or moves it later. A
 * wrong match is not, because merging hard-deletes the loser record and takes
 * its history with it. So the matcher returns null unless exactly one
 * candidate survives, and the caller creates a new external person instead of
 * guessing. Names are never matched: two clients called "John Smith" must not
 * collapse into one record.
 */
export function matchPersonByEmail(rows: ExternalPersonCandidate[], email: string): string | null {
  const wanted = text(email).toLowerCase();
  if (!wanted) return null;
  const matches = uniqueById(rowsOf(rows).filter((row) => text(row?.email).toLowerCase() === wanted));
  return matches.length === 1 ? text(matches[0].id) || null : null;
}
