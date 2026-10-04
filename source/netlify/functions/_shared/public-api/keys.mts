/**
 * API keys: how another system proves it may act for a business.
 *
 * The shape follows Stripe's, because it is the one most developers already
 * know:
 *
 *   ck_live_<32 random chars>   a real business
 *   ck_test_<32 random chars>   that business's sandbox
 *
 * The prefix is not decoration. A key pasted into the wrong place says which
 * world it belongs to, and a secret scanner (GitHub's included) can recognise
 * it. Only a SHA-256 hash is stored, so the key is shown exactly once -- when
 * it is made -- and a leaked database reveals nothing usable.
 *
 * A key belongs to one account and carries scopes. It can never reach another
 * account: the account comes from the key row, never from the request.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "../database.mts";

export const API_SCOPES = [
  "bookings:read",
  "bookings:write",
  "clients:read",
  "clients:write",
  "catalog:read",
  "passes:read",
  "passes:write",
  "invoices:read",
  "invoices:write",
  "sales:read",
  "sales:write",
  "events:read",
  "webhooks:manage",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  "bookings:read": "Read bookings",
  "bookings:write": "Create, cancel and reschedule bookings",
  "clients:read": "Read clients",
  "clients:write": "Create and update clients",
  "catalog:read": "Read lesson types, pass types, coaches, locations and availability",
  "passes:read": "Read passes and their balances",
  "passes:write": "Issue, redeem and void passes",
  "invoices:read": "Read invoices",
  "invoices:write": "Create, send, mark paid, void and delete draft invoices",
  "sales:read": "Read till sales, products and payment methods",
  "sales:write": "Record till sales, mark them paid, refund, void and email receipts",
  "events:read": "Read the event feed",
  "webhooks:manage": "Subscribe and unsubscribe webhooks",
};

export type ApiKeyMode = "live" | "test";

export type ApiKeyRecord = {
  id: string;
  accountId: string;
  name: string;
  mode: ApiKeyMode;
  hint: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

/** What the key-auth step hands every route. */
export type ApiPrincipal = {
  keyId: string;
  accountId: string;
  mode: ApiKeyMode;
  scopes: Set<ApiScope>;
};

const KEY_PATTERN = /^ck_(live|test)_[A-Za-z0-9_-]{32,64}$/;

function db() {
  return getDatabase();
}

export function hashApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

export function cleanScopes(value: unknown): ApiScope[] {
  const list = Array.isArray(value) ? value : [];
  const wanted = new Set(list.map((entry) => String(entry)));
  return API_SCOPES.filter((scope) => wanted.has(scope));
}

/** A fresh key and the parts of it that are safe to keep. Pure; exported for tests. */
export function mintApiKey(mode: ApiKeyMode) {
  const secret = randomBytes(24).toString("base64url"); // 32 chars
  const key = `ck_${mode}_${secret}`;
  return { key, hash: hashApiKey(key), hint: `ck_${mode}_…${key.slice(-4)}` };
}

export function looksLikeApiKey(value: string) {
  return KEY_PATTERN.test(value);
}

function toRecord(row: any): ApiKeyRecord {
  const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    name: String(row.name || ""),
    mode: row.mode === "test" ? "test" : "live",
    hint: String(row.key_hint || ""),
    scopes: cleanScopes(row.scopes),
    createdBy: String(row.created_by || ""),
    createdAt: iso(row.created_at) || "",
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
  };
}

export async function listApiKeys(accountId: string): Promise<ApiKeyRecord[]> {
  const rows = await db().sql`
    SELECT id, account_id, name, mode, key_hint, scopes, created_by, created_at,
           last_used_at, expires_at, revoked_at
    FROM api_keys
    WHERE account_id = ${accountId}
    ORDER BY revoked_at IS NOT NULL, created_at DESC
  `;
  return rows.map(toRecord);
}

/** Makes a key. The returned `key` is the only time the full value exists outside the caller's system. */
export async function createApiKey(input: {
  accountId: string;
  mode: ApiKeyMode;
  name: string;
  scopes: ApiScope[];
  createdBy: string;
  expiresAt?: string | null;
}): Promise<{ key: string; record: ApiKeyRecord }> {
  const minted = mintApiKey(input.mode);
  const id = `key_${randomUUID().replace(/-/g, "")}`;
  const rows = await db().sql`
    INSERT INTO api_keys (id, account_id, name, mode, key_hash, key_hint, scopes, created_by, expires_at)
    VALUES (
      ${id}, ${input.accountId}, ${input.name.slice(0, 80)}, ${input.mode}, ${minted.hash},
      ${minted.hint}, ${input.scopes}, ${input.createdBy.slice(0, 180)}, ${input.expiresAt || null}
    )
    RETURNING id, account_id, name, mode, key_hint, scopes, created_by, created_at,
              last_used_at, expires_at, revoked_at
  `;
  return { key: minted.key, record: toRecord(rows[0]) };
}

export async function revokeApiKey(accountId: string, keyId: string): Promise<boolean> {
  const rows = await db().sql`
    UPDATE api_keys SET revoked_at = NOW()
    WHERE id = ${keyId} AND account_id = ${accountId} AND revoked_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return false;
  // Hooks a revoked key subscribed stop too: whatever made them can no longer
  // manage them, so leaving them firing would be a subscription nobody owns.
  await db().sql`
    UPDATE api_webhook_endpoints
    SET enabled = false, disabled_reason = 'The API key that created it was revoked.', updated_at = NOW()
    WHERE account_id = ${accountId} AND created_by_key_id = ${keyId}
  `;
  return true;
}

/**
 * Bearer token -> principal, or null.
 *
 * Null covers every failure (malformed, unknown, revoked, expired, account
 * gone) on purpose: telling a caller WHICH one lets them probe for keys.
 */
export async function authenticateApiKey(token: string): Promise<ApiPrincipal | null> {
  if (!looksLikeApiKey(token)) return null;
  const rows = await db().sql`
    SELECT api_keys.id, api_keys.account_id, api_keys.mode, api_keys.scopes, api_keys.last_used_at
    FROM api_keys
    JOIN accounts ON accounts.id = api_keys.account_id AND accounts.status = 'active'
    WHERE api_keys.key_hash = ${hashApiKey(token)}
      AND api_keys.revoked_at IS NULL
      AND (api_keys.expires_at IS NULL OR api_keys.expires_at > NOW())
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  // Written at most once a minute: a busy integration should not turn every
  // read into a write.
  const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - last > 60_000) {
    await db().sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${row.id}`.catch(() => undefined);
  }
  return {
    keyId: String(row.id),
    accountId: String(row.account_id),
    mode: row.mode === "test" ? "test" : "live",
    scopes: new Set(cleanScopes(row.scopes)),
  };
}
