import { randomUUID } from "node:crypto";

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

/** Case and spacing are not identity: "Charles  Sham" is "charles sham". */
function normalisedName(value: unknown) {
  return text(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Identity by name, for providers that never send an email.
 *
 * Optix product sales carry a display name and nothing else, so email
 * matching cannot reach them and the purchase would stay unlinked forever.
 * This is the deliberate exception to "names are never matched", and it keeps
 * the rule that made email matching safe: **exactly one** candidate, or no
 * answer at all. Two clients called "Sam Hale" — which this account really has
 * — produce null, and the caller files a new external client instead.
 *
 * The residual risk is a real one and cannot be designed away: the account may
 * hold exactly one "John Smith" while the buyer is a different John Smith. It
 * is accepted only because the caller records that the link was made this way
 * (`person_link_source: "name"`), so a wrong one is visible and reversible —
 * unlike a merge, which is not.
 */
export function matchPersonByExactName(rows: ExternalPersonCandidate[], name: string): string | null {
  const wanted = normalisedName(name);
  if (!wanted) return null;
  const matches = uniqueById(rowsOf(rows).filter((row) => normalisedName(row?.name) === wanted));
  return matches.length === 1 ? text(matches[0].id) || null : null;
}

function isDuplicateEmailError(error: any) {
  const code = String(error?.code || "");
  const message = error instanceof Error ? error.message : "";
  return code === "23505" || /duplicate key|unique constraint|idx_people_.*email/i.test(message);
}

export type NewExternalPerson = { name: string; email?: string | null; phone?: string | null };

/**
 * Files someone Clarity has never seen arriving from a provider, whether that
 * provider sent a booking or a purchase.
 *
 * external: TRUE puts the new person in the external booking clients list,
 * not the main client list — never the main list, because that would be a
 * silent guess about which existing client this is. An admin merges or moves
 * them across explicitly. This is the one and only way an unmatched arrival
 * gets a person record; nothing upstream of this may match by name.
 */
export async function createExternalPerson(accountId: string, provider: string, details: NewExternalPerson): Promise<string> {
  const personId = randomUUID();
  const email = text(details.email || "");
  try {
    await integrationRequest("people", {
      method: "POST",
      body: JSON.stringify([{ id: personId, account_id: accountId, name: details.name, email: email || null, phone: details.phone || null, source: provider, external: true }]),
    });
    return personId;
  } catch (error: any) {
    // The account-scoped unique index on email means at most one person can
    // hold this address, so re-reading it resolves a constraint rather than
    // guessing between candidates. Anything else is a real failure and must
    // surface.
    if (!email || !isDuplicateEmailError(error)) throw error;
    const rows = await integrationRequest(`people?account_id=eq.${encodeURIComponent(accountId)}&email=ilike.${encodeURIComponent(email)}&select=id,name,email,phone&limit=10`);
    const matched = matchPersonByEmail(rowsOf(rows), email);
    if (matched) return matched;
    throw error;
  }
}
