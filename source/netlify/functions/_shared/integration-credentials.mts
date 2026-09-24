import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { legacyOriginalWorkspaceId } from "./account.mts";
import { getDatabase } from "./database.mts";

/**
 * Per-business credentials for the integrations a coach connects themselves.
 *
 * Before this, Optix, Akahu and Stripe's webhook secret existed only as
 * deployment env vars -- the original workspace's own tokens. So exactly one
 * business could ever connect them, and every other business either borrowed
 * that business's connection or had nothing. This is the store that lets each
 * business connect its own.
 *
 * The rule every reader follows, in one place (credentialReaderFor):
 *
 *   1. a value this business saved wins;
 *   2. the original workspace falls back to the env vars it has always used,
 *      so nothing about it changes until its owner saves something here;
 *   3. any other business falls back to NOTHING. The env vars are somebody
 *      else's Optix org and bank feed, not a platform default.
 *
 * Values are AES-256-GCM encrypted at rest. The key is
 * INTEGRATION_CREDENTIAL_ENCRYPTION_KEY, falling back to the Google token key
 * that already exists in every environment, so this works without a new
 * secret being provisioned first. Each value records which key sealed it.
 *
 * THE VALUES ARE SECRETS. Nothing here returns a secret to a browser:
 * storedCredentialFields reports set / length / fingerprint, and a value only
 * for a field the catalogue marks as not secret.
 */

export type CredentialReader = (name: string) => string;

/** Integrations a business connects itself, and so may store credentials for. */
export const TENANT_INTEGRATION_IDS = ["optix", "akahu", "stripe"] as const;
export type TenantIntegrationId = (typeof TENANT_INTEGRATION_IDS)[number];

export function isTenantIntegration(id: string): id is TenantIntegrationId {
  return (TENANT_INTEGRATION_IDS as readonly string[]).includes(id);
}

/**
 * Deployment settings a credential reader may still pass through for any
 * business. Deliberately tiny: these describe the deployment, not an account.
 */
const PLATFORM_PASSTHROUGH = new Set(["CLARITY_TIMEZONE"]);

function env(name: string): string {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function db() {
  return getDatabase();
}

export function isOriginalWorkspace(accountId: string): boolean {
  return Boolean(accountId) && accountId === legacyOriginalWorkspaceId();
}

// --- Encryption ------------------------------------------------------------

type SealedValue = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

const KEY_SOURCES: Array<{ keyId: string; envName: string }> = [
  { keyId: "ic1", envName: "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY" },
  { keyId: "google-v1", envName: "GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1" },
];

function decodeKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates = [
    () => Buffer.from(trimmed, "base64url"),
    () => Buffer.from(trimmed, "base64"),
    () => (/^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.alloc(0)),
  ];
  for (const decode of candidates) {
    const key = decode();
    if (key.length === 32) return key;
  }
  return null;
}

function keyById(keyId: string): Buffer | null {
  const source = KEY_SOURCES.find((entry) => entry.keyId === keyId);
  return source ? decodeKey(env(source.envName)) : null;
}

function sealingKey(): { keyId: string; key: Buffer } {
  for (const source of KEY_SOURCES) {
    const key = decodeKey(env(source.envName));
    if (key) return { keyId: source.keyId, key };
  }
  throw Object.assign(
    new Error(
      "Integration credentials cannot be saved: no encryption key is configured. " +
        "Set INTEGRATION_CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64) on the site.",
    ),
    { status: 500, code: "CREDENTIAL_ENCRYPTION_KEY_MISSING" },
  );
}

export function sealCredential(value: string): SealedValue {
  const { keyId, key } = sealingKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function openCredential(payload: unknown): string {
  const sealed = payload as Partial<SealedValue> | null;
  if (!sealed || sealed.version !== 1 || sealed.algorithm !== "aes-256-gcm" || !sealed.iv || !sealed.ciphertext || !sealed.authTag) {
    throw new Error("Stored credential is malformed.");
  }
  const key = keyById(String(sealed.keyId || ""));
  if (!key) throw new Error(`The key that sealed this credential (${sealed.keyId}) is not configured.`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Four hex characters of a salted hash. The same recipe integration-setup
 * uses for env vars, so a value reads the same whichever place holds it.
 */
export function credentialFingerprint(key: string, value: string): string {
  return createHash("sha256").update(`clarity:${key}:${value}`).digest("hex").slice(0, 4);
}

// --- Reading ---------------------------------------------------------------

type CredentialRow = {
  field_key: string;
  encrypted_value_json: string;
  value_length: number;
  fingerprint: string;
  is_secret: boolean;
  updated_at: string | Date;
};

async function readRows(accountId: string, integrationId: string): Promise<CredentialRow[]> {
  if (!accountId || !integrationId) return [];
  return (await db().sql`
    SELECT field_key, encrypted_value_json, value_length, fingerprint, is_secret, updated_at
    FROM integration_credentials
    WHERE account_id = ${accountId} AND integration_id = ${integrationId}
  `) as CredentialRow[];
}

/** The decrypted values this business has saved for one integration. */
export async function readStoredCredentials(
  accountId: string,
  integrationId: string,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  // A failed read degrades to "nothing saved": the original workspace keeps
  // working off its env vars, and a tenant reads as not connected, rather than
  // every Optix or Akahu call throwing because this table was unreachable.
  const rows = await readRows(accountId, integrationId).catch((error) => {
    console.error("integration_credentials:read_failed", {
      accountId,
      integrationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [] as CredentialRow[];
  });
  for (const row of rows) {
    try {
      values[row.field_key] = openCredential(JSON.parse(row.encrypted_value_json));
    } catch (error) {
      // An undecryptable value reads as unset -- the integration reports "not
      // configured" and the coach re-enters it -- rather than failing every
      // request that touches the integration.
      console.error("integration_credentials:decrypt_failed", {
        accountId,
        integrationId,
        field: row.field_key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return values;
}

/** Build a reader from values already loaded. Exported for tests. */
export function credentialReaderFor(accountId: string, stored: Record<string, string>): CredentialReader {
  const original = isOriginalWorkspace(accountId);
  return (name: string) => {
    const own = String(stored[name] ?? "").trim();
    if (own) return own;
    if (original || PLATFORM_PASSTHROUGH.has(name)) return env(name);
    return "";
  };
}

/**
 * The credentials one business uses for one integration.
 *
 * Returns a reader in the shape the integration code already takes (`env`),
 * so switching a call site from the environment to the business is passing a
 * different function, not rewriting it.
 */
export async function integrationCredentials(
  accountId: string,
  integrationId: TenantIntegrationId,
): Promise<CredentialReader> {
  return credentialReaderFor(accountId, await readStoredCredentials(accountId, integrationId));
}

/** What a settings screen may know about the saved fields. Never a secret. */
export async function storedCredentialFields(accountId: string, integrationId: string) {
  const rows = await readRows(accountId, integrationId).catch(() => [] as CredentialRow[]);
  const fields: Record<string, { length: number; fingerprint: string; value: string; updatedAt: string }> = {};
  for (const row of rows) {
    let value = "";
    if (!row.is_secret) {
      try {
        value = openCredential(JSON.parse(row.encrypted_value_json));
      } catch {
        value = "";
      }
    }
    fields[row.field_key] = {
      length: Number(row.value_length || 0),
      fingerprint: row.fingerprint || "",
      value,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ""),
    };
  }
  return fields;
}

/** Every business that has saved anything for an integration. */
export async function accountsWithStoredCredentials(integrationId: string): Promise<string[]> {
  const rows = (await db().sql`
    SELECT DISTINCT account_id FROM integration_credentials
    WHERE integration_id = ${integrationId}
    ORDER BY account_id
  `) as Array<{ account_id: string }>;
  return rows.map((row) => row.account_id).filter(Boolean);
}

// --- Writing ---------------------------------------------------------------

/**
 * Save, replace or clear fields for one business.
 *
 * `null` or an empty string clears a field. Values are trimmed first: a
 * trailing newline on a pasted token is the classic cause of every request
 * coming back 401, and here, unlike an env var, we can simply not store it.
 */
export async function saveIntegrationCredentials(input: {
  accountId: string;
  integrationId: TenantIntegrationId;
  values: Record<string, string | null>;
  secretKeys: Set<string>;
  updatedBy: string;
}) {
  const { accountId, integrationId } = input;
  if (!accountId) throw Object.assign(new Error("A business is required."), { status: 400 });
  for (const [key, raw] of Object.entries(input.values)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      await db().sql`
        DELETE FROM integration_credentials
        WHERE account_id = ${accountId} AND integration_id = ${integrationId} AND field_key = ${key}
      `;
      continue;
    }
    const sealed = JSON.stringify(sealCredential(value));
    await db().sql`
      INSERT INTO integration_credentials (
        account_id, integration_id, field_key, encrypted_value_json,
        value_length, fingerprint, is_secret, updated_by, created_at, updated_at
      ) VALUES (
        ${accountId}, ${integrationId}, ${key}, ${sealed},
        ${value.length}, ${credentialFingerprint(key, value)}, ${input.secretKeys.has(key)},
        ${input.updatedBy.slice(0, 200)}, NOW(), NOW()
      )
      ON CONFLICT (account_id, integration_id, field_key) DO UPDATE SET
        encrypted_value_json = EXCLUDED.encrypted_value_json,
        value_length = EXCLUDED.value_length,
        fingerprint = EXCLUDED.fingerprint,
        is_secret = EXCLUDED.is_secret,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
    `;
  }
}

// --- Inbound webhooks ------------------------------------------------------

/** The query parameter a business's own webhook URL carries. */
export const WEBHOOK_ACCOUNT_PARAM = "account";

/**
 * Which business an inbound webhook is for.
 *
 * A business's webhook URL names it (?account=<slug or id>); the caller then
 * verifies the delivery with THAT business's secret, which is what actually
 * binds the delivery to it -- naming an account buys nothing without its
 * secret. A URL naming no account is the original workspace's, exactly as it
 * was before businesses had URLs of their own. Null means a named account that
 * does not exist, which the caller refuses.
 */
export async function resolveWebhookAccount(req: Request): Promise<string | null> {
  const named = String(new URL(req.url).searchParams.get(WEBHOOK_ACCOUNT_PARAM) || "")
    .trim()
    .toLowerCase()
    .slice(0, 80);
  if (!named) return legacyOriginalWorkspaceId();
  const rows = (await db().sql`
    SELECT id FROM accounts
    WHERE (id = ${named} OR slug = ${named}) AND status = 'active'
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows[0]?.id || null;
}

/** The webhook URL a business registers with a provider. */
export function webhookUrlForAccount(origin: string, path: string, accountId: string): string {
  const url = new URL(path, origin);
  if (!isOriginalWorkspace(accountId)) url.searchParams.set(WEBHOOK_ACCOUNT_PARAM, accountId);
  return url.toString();
}

/**
 * A business's own Stripe secret key.
 *
 * It lives in `settings` (accountStripeSecretKey), where the Billing screen
 * has always saved it, rather than in this table: one key, one place. Read
 * here so code with no settings reader of its own -- the webhook and the
 * billing sync -- can pass it to resolveStripeCredential.
 */
export async function readAccountStripeSecret(accountId: string): Promise<string> {
  if (!accountId) return "";
  const rows = (await db()
    .sql`
      SELECT value FROM settings
      WHERE account_id = ${accountId} AND key = 'accountStripeSecretKey'
      LIMIT 1
    `
    .catch(() => [])) as Array<{ value: string }>;
  return String(rows[0]?.value || "").trim();
}
