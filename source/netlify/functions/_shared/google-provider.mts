import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

export const googleCalendarScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const googleDriveFileScope = "https://www.googleapis.com/auth/drive.file";

const provider = "google";
const encryptionKeyId = "v1";
const encryptionVersion = 1;
const encryptionAlgorithm = "aes-256-gcm";

export type EncryptedSecret = {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

type GoogleProviderConnectionRow = {
  id: string;
  account_id: string;
  provider: "google";
  provider_user_id?: string | null;
  provider_email?: string | null;
  encrypted_refresh_token_json: string;
  encrypted_refresh_token_version: number;
  granted_scopes_json: string;
  calendar_enabled: boolean;
  drive_enabled: boolean;
  connection_status: string;
  connected_at: string;
  updated_at: string;
  last_token_refresh_at?: string | null;
  last_successful_use_at?: string | null;
  revoked_at?: string | null;
  last_error_code?: string | null;
  last_error_at?: string | null;
};

export type GoogleProviderConnection = {
  id: string;
  accountId: string;
  providerEmail: string;
  providerUserId: string;
  grantedScopes: string[];
  calendarEnabled: boolean;
  driveEnabled: boolean;
  connectionStatus: string;
  connectedAt: string;
  updatedAt: string;
  lastTokenRefreshAt: string;
  lastSuccessfulUseAt: string;
  revokedAt: string;
  lastErrorCode: string;
  lastErrorAt: string;
};

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown, fallback = "", max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function base64UrlEncode(buffer: Buffer) {
  return buffer.toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url");
}

function parseEncryptionKey() {
  const raw = env("GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1", "");
  if (!raw) {
    throw Object.assign(new Error("Google provider token encryption key is not configured."), {
      code: "GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING",
      status: 500,
    });
  }

  const trimmed = raw.trim();
  const candidates = [
    () => Buffer.from(trimmed, "base64url"),
    () => Buffer.from(trimmed, "base64"),
    () => (/^[a-f0-9]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.alloc(0)),
  ];
  for (const decode of candidates) {
    const key = decode();
    if (key.length === 32) return key;
  }
  throw Object.assign(new Error("Google provider token encryption key must decode to exactly 32 bytes."), {
    code: "GOOGLE_TOKEN_ENCRYPTION_KEY_INVALID",
    status: 500,
  });
}

export function encryptRefreshToken(refreshToken: string): EncryptedSecret {
  const cleanToken = cleanString(refreshToken, "", 5000);
  if (!cleanToken) {
    throw Object.assign(new Error("Refresh token is required."), {
      code: "GOOGLE_REFRESH_TOKEN_MISSING",
      status: 400,
    });
  }
  const key = parseEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(cleanToken, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: encryptionVersion,
    algorithm: encryptionAlgorithm,
    keyId: encryptionKeyId,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext),
    authTag: base64UrlEncode(authTag),
  };
}

export function decryptRefreshToken(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("Encrypted refresh token payload is malformed."), {
      code: "GOOGLE_TOKEN_DECRYPT_FAILED",
      status: 500,
    });
  }
  const candidate = payload as Partial<EncryptedSecret>;
  if (
    candidate.version !== encryptionVersion ||
    candidate.algorithm !== encryptionAlgorithm ||
    candidate.keyId !== encryptionKeyId ||
    !candidate.iv ||
    !candidate.ciphertext ||
    !candidate.authTag
  ) {
    throw Object.assign(new Error("Encrypted refresh token payload is invalid."), {
      code: "GOOGLE_TOKEN_DECRYPT_FAILED",
      status: 500,
    });
  }
  try {
    const key = parseEncryptionKey();
    const decipher = createDecipheriv("aes-256-gcm", key, base64UrlDecode(candidate.iv));
    decipher.setAuthTag(base64UrlDecode(candidate.authTag));
    return Buffer.concat([
      decipher.update(base64UrlDecode(candidate.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw Object.assign(new Error("Google refresh token could not be decrypted."), {
      code: "GOOGLE_TOKEN_DECRYPT_FAILED",
      status: 500,
    });
  }
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

export async function readSettings() {
  const rows = await supabase("settings", { query: "select=key,value" });
  return Object.fromEntries(rows.map((row: { key: string; value: string }) => [row.key, row.value || ""]));
}

export async function setSettings(values: Record<string, unknown>) {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value: String(value ?? ""), updated_at: nowIso() }));
  if (!rows.length) return;
  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: rows,
  });
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function cleanSlug(value: unknown, fallback = "sam-hale-golf") {
  const trimmed = cleanString(value, "", 140)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return trimmed || fallback;
}

export function resolveGoogleAccountId(settings: Record<string, string>) {
  const accounts = parseJson<Array<{ id?: string; active?: boolean }>>(settings.workspaceAccountsJson, []);
  const active = accounts.find((account) => account?.active !== false)?.id || accounts[0]?.id;
  return cleanSlug(active || settings.accountCalendarSlug || settings.accountId, "sam-hale-golf");
}

export function mergeGoogleScopes(existing: string[] = [], next: string[] = []) {
  return Array.from(new Set([...existing, ...next].map((scope) => cleanString(scope, "", 400)).filter(Boolean))).sort();
}

export function hasGoogleScopes(connection: Pick<GoogleProviderConnection, "grantedScopes"> | null, requiredScopes: string[]) {
  if (!connection) return false;
  const granted = new Set(connection.grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope));
}

function rowToConnection(row?: GoogleProviderConnectionRow | null): GoogleProviderConnection | null {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    providerEmail: row.provider_email || "",
    providerUserId: row.provider_user_id || "",
    grantedScopes: parseJson<string[]>(row.granted_scopes_json, []),
    calendarEnabled: row.calendar_enabled === true,
    driveEnabled: row.drive_enabled === true,
    connectionStatus: row.connection_status || "connected",
    connectedAt: row.connected_at || "",
    updatedAt: row.updated_at || "",
    lastTokenRefreshAt: row.last_token_refresh_at || "",
    lastSuccessfulUseAt: row.last_successful_use_at || "",
    revokedAt: row.revoked_at || "",
    lastErrorCode: row.last_error_code || "",
    lastErrorAt: row.last_error_at || "",
  };
}

async function loadGoogleProviderConnectionRow(accountId: string): Promise<GoogleProviderConnectionRow | null> {
  const rows = await supabase("google_provider_connections", {
    query: `select=*&account_id=eq.${encodeURIComponent(accountId)}&provider=eq.${provider}&limit=1`,
  });
  return rows[0] || null;
}

export async function loadGoogleProviderConnection(accountId: string) {
  return rowToConnection(await loadGoogleProviderConnectionRow(accountId));
}

async function upsertGoogleProviderConnection(row: GoogleProviderConnectionRow) {
  await supabase("google_provider_connections", {
    method: "POST",
    query: "on_conflict=account_id,provider",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [row],
  });
}

function googleConfig() {
  return {
    clientId: env("GOOGLE_CLIENT_ID", "") || env("GOOGLE_CALENDAR_CLIENT_ID", ""),
    clientSecret: env("GOOGLE_CLIENT_SECRET", "") || env("GOOGLE_CALENDAR_CLIENT_SECRET", ""),
  };
}

async function tokenRequest(params: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw Object.assign(new Error(data.error_description || data.error || "Google token request failed."), {
      status: response.status,
      code: data.error === "invalid_grant" ? "GOOGLE_RECONNECT_REQUIRED" : "GOOGLE_TOKEN_REFRESH_FAILED",
    });
  }
  return data;
}

export async function saveGoogleAuthorization(args: {
  accountId: string;
  refreshToken?: string;
  grantedScopes: string[];
  providerEmail?: string;
  providerUserId?: string;
  enableCalendar?: boolean;
  enableDrive?: boolean;
}) {
  const existingRow = await loadGoogleProviderConnectionRow(args.accountId);
  const existingConnection = rowToConnection(existingRow);
  const now = nowIso();
  let encryptedRefreshTokenJson = existingRow?.encrypted_refresh_token_json || "";
  if (args.refreshToken) {
    encryptedRefreshTokenJson = JSON.stringify(encryptRefreshToken(args.refreshToken));
    decryptRefreshToken(JSON.parse(encryptedRefreshTokenJson));
  }
  if (!encryptedRefreshTokenJson) {
    throw Object.assign(new Error("Google did not return an offline refresh token. Reconnect Google to continue."), {
      code: "GOOGLE_RECONNECT_REQUIRED",
      status: 400,
    });
  }
  const grantedScopes = mergeGoogleScopes(existingConnection?.grantedScopes || [], args.grantedScopes);
  const row: GoogleProviderConnectionRow = {
    id: existingRow?.id || randomUUID(),
    account_id: args.accountId,
    provider,
    provider_user_id: cleanString(args.providerUserId, existingRow?.provider_user_id || "", 180),
    provider_email: cleanString(args.providerEmail, existingRow?.provider_email || "", 180).toLowerCase(),
    encrypted_refresh_token_json: encryptedRefreshTokenJson,
    encrypted_refresh_token_version: encryptionVersion,
    granted_scopes_json: JSON.stringify(grantedScopes),
    calendar_enabled: args.enableCalendar === true || existingRow?.calendar_enabled === true,
    drive_enabled: args.enableDrive === true || existingRow?.drive_enabled === true,
    connection_status: "connected",
    connected_at: existingRow?.connected_at || now,
    updated_at: now,
    last_token_refresh_at: existingRow?.last_token_refresh_at || null,
    last_successful_use_at: existingRow?.last_successful_use_at || null,
    revoked_at: null,
    last_error_code: null,
    last_error_at: null,
  };
  await upsertGoogleProviderConnection(row);
  return rowToConnection(row);
}

export async function markConnectionError(accountId: string, code: string) {
  const existing = await loadGoogleProviderConnectionRow(accountId);
  if (!existing) return;
  await upsertGoogleProviderConnection({
    ...existing,
    connection_status: code === "GOOGLE_RECONNECT_REQUIRED" ? "reconnect_required" : "error",
    last_error_code: code,
    last_error_at: nowIso(),
    updated_at: nowIso(),
  });
}

export async function markConnectionHealthy(accountId: string) {
  const existing = await loadGoogleProviderConnectionRow(accountId);
  if (!existing) return;
  await upsertGoogleProviderConnection({
    ...existing,
    connection_status: "connected",
    last_token_refresh_at: nowIso(),
    last_successful_use_at: nowIso(),
    last_error_code: null,
    last_error_at: null,
    updated_at: nowIso(),
  });
}

export async function getGoogleAccessToken(accountId: string, requiredScopes: string[]) {
  const row = await loadGoogleProviderConnectionRow(accountId);
  const connection = rowToConnection(row);
  if (!connection || !row) {
    throw Object.assign(new Error("Google connection not found."), { code: "GOOGLE_CONNECTION_NOT_FOUND", status: 409 });
  }
  if (!hasGoogleScopes(connection, requiredScopes)) {
    await markConnectionError(accountId, "GOOGLE_SCOPE_MISSING");
    throw Object.assign(new Error("Google connection is missing required scopes."), { code: "GOOGLE_SCOPE_MISSING", status: 409 });
  }
  try {
    const refreshToken = decryptRefreshToken(JSON.parse(row.encrypted_refresh_token_json));
    const config = googleConfig();
    const data = await tokenRequest({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    await markConnectionHealthy(accountId);
    return data.access_token as string;
  } catch (error: any) {
    await markConnectionError(accountId, error?.code || "GOOGLE_TOKEN_REFRESH_FAILED");
    throw error;
  }
}

export async function disconnectGoogleService(accountId: string, service: "calendar" | "drive" | "all") {
  const existing = await loadGoogleProviderConnectionRow(accountId);
  if (!existing) return;
  const now = nowIso();
  const calendarEnabled = service === "calendar" ? false : service === "all" ? false : existing.calendar_enabled;
  const driveEnabled = service === "drive" ? false : service === "all" ? false : existing.drive_enabled;
  await upsertGoogleProviderConnection({
    ...existing,
    calendar_enabled: calendarEnabled,
    drive_enabled: driveEnabled,
    connection_status: calendarEnabled || driveEnabled ? existing.connection_status : "disconnected",
    revoked_at: service === "all" ? now : existing.revoked_at,
    updated_at: now,
  });
}

export async function migrateLegacyGoogleCalendarToken(settings?: Record<string, string>) {
  const currentSettings = settings || (await readSettings());
  const legacyToken = cleanString(currentSettings.googleCalendarRefreshToken, "", 5000);
  const accountId = resolveGoogleAccountId(currentSettings);
  const existing = await loadGoogleProviderConnection(accountId);
  if (!legacyToken) {
    return { ok: true, migrated: false, accountId, reason: existing ? "already_migrated" : "no_legacy_token" };
  }
  const migrated = await saveGoogleAuthorization({
    accountId,
    refreshToken: legacyToken,
    grantedScopes: googleCalendarScopes,
    providerEmail: currentSettings.googleCalendarAccountEmail || "",
    enableCalendar: true,
  });
  if (!migrated) {
    throw Object.assign(new Error("Legacy Google token migration did not create a provider connection."), {
      code: "GOOGLE_LEGACY_MIGRATION_FAILED",
      status: 500,
    });
  }
  await setSettings({ googleCalendarRefreshToken: "" });
  return { ok: true, migrated: true, accountId };
}

export function publicGoogleProviderStatus(connection: GoogleProviderConnection | null, requiredScopes: string[] = []) {
  return {
    connected: Boolean(connection?.calendarEnabled || connection?.driveEnabled),
    accountEmail: connection?.providerEmail || "",
    connectedAt: connection?.connectedAt || "",
    grantedScopes: connection?.grantedScopes || [],
    missingScopes: connection ? requiredScopes.filter((scope) => !connection.grantedScopes.includes(scope)) : requiredScopes,
    connectionStatus: connection?.connectionStatus || "disconnected",
    lastErrorCode: connection?.lastErrorCode || "",
    lastErrorAt: connection?.lastErrorAt || "",
  };
}
