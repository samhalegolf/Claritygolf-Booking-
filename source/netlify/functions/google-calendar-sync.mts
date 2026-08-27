import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import {
  disconnectGoogleService,
  getGoogleAccessToken,
  googleCalendarScopes as googleScopes,
  hasGoogleScopes,
  loadGoogleProviderConnection,
  markConnectionHealthy,
  migrateLegacyGoogleCalendarToken,
  noteGoogleApiFailure,
  publicGoogleProviderStatus,
  resolveGoogleAccountId,
  saveGoogleAuthorization,
} from "./_shared/google-provider.mts";
import { unavailableSpans } from "./_shared/availability-blocks.mts";
import { defaultAccountId } from "./_shared/account.mts";
import { getClarityCloudGoogleConfig } from "./_shared/clarity-cloud-google-config.mts";
import {
  GOOGLE_IMPORT_ORIGIN,
  busyBlocksFromGoogleEvents,
  planBusyBlockImport,
  type GoogleCalendarSourceDisplay,
  type GoogleEvent,
} from "./_shared/google-calendar-import.mts";

const sessionCookieName = "clarity_session";
const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
// Auto-sync every booking change to Google Calendar. Each booking mutation path
// (admin save/delete, single-item upsert, public booking + cancel) calls
// syncGoogleCalendarIfEnabled(); with this false those calls actually run,
// gated only by the per-account googleCalendarAutoSync setting.
const googleCalendarManualSyncOnly = false;

const defaultServices = [
  { id: "lesson-30", name: "30min Lesson", duration: 30, price: 100, lessonNote: "Bay hire included", location: "Bay hire included" },
  { id: "lesson-60", name: "1 Hour Golf Lesson", duration: 60, price: 180, lessonNote: "Bay hire included", location: "Bay hire included" },
  { id: "lesson-pair", name: "2 Person Golf Lesson", duration: 60, price: 200, lessonNote: "Bay hire included", location: "Bay hire included" },
];

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown, fallback = "", max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeaderValue
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
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

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabase("admin_sessions", {
    query: `select=id&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
  });
  return rows.length > 0;
}

function settingMap(rows: Array<{ key: string; value: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value || ""]));
}

async function readSettings() {
  return settingMap(await supabase("settings", { query: "select=key,value" }));
}

async function setSetting(key: string, value: unknown) {
  await supabase("settings", {
    method: "POST",
    query: "on_conflict=key",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ key, value: String(value ?? ""), updated_at: nowIso() }],
  });
}

async function setSettings(values: Record<string, unknown>) {
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

function cleanGoogleCalendarSourcePreference(value: unknown, fallback: GoogleCalendarSourcePreference): GoogleCalendarSourcePreference {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const showOnClarity =
    typeof candidate.showOnClarity === "boolean" ? candidate.showOnClarity : fallback.showOnClarity;
  const showLabel = showOnClarity
    ? typeof candidate.showLabel === "boolean"
      ? candidate.showLabel
      : fallback.showLabel
    : false;
  return { showOnClarity, showLabel };
}

function defaultGoogleCalendarSourcePreference(source: Pick<GoogleCalendarSource, "id" | "primary">, calendarId: string) {
  const matchesTarget = source.id === calendarId || (calendarId === "primary" && source.primary);
  return {
    showOnClarity: matchesTarget,
    showLabel: matchesTarget,
  };
}

function readGoogleCalendarSourcePreferenceMap(settings: Record<string, string>) {
  const raw = parseJson<Record<string, unknown>>(settings[googleCalendarSourcePreferencesSettingKey], {});
  const cleaned: Record<string, GoogleCalendarSourcePreference> = {};
  for (const [sourceId, value] of Object.entries(raw || {})) {
    const id = cleanString(sourceId, "", 320);
    if (!id) continue;
    cleaned[id] = cleanGoogleCalendarSourcePreference(value, { showOnClarity: false, showLabel: false });
  }
  return cleaned;
}

function sourcePreferenceMapForStorage(input: unknown, knownSources: Array<Pick<GoogleCalendarSource, "id" | "primary">>, calendarId: string) {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const normalized: Record<string, GoogleCalendarSourcePreference> = {};
  const knownById = new Map(knownSources.map((source) => [source.id, source]));
  for (const [sourceId, value] of Object.entries(raw)) {
    const id = cleanString(sourceId, "", 320);
    if (!id) continue;
    const fallback = defaultGoogleCalendarSourcePreference(knownById.get(id) || { id, primary: false }, calendarId);
    normalized[id] = cleanGoogleCalendarSourcePreference(value, fallback);
  }
  return normalized;
}

function applyGoogleCalendarSourcePreferences(
  sources: GoogleCalendarSource[],
  preferences: Record<string, GoogleCalendarSourcePreference>,
  calendarId: string,
) {
  return sources.map((source) => ({
    ...source,
    ...cleanGoogleCalendarSourcePreference(preferences[source.id], defaultGoogleCalendarSourcePreference(source, calendarId)),
  }));
}

// ---------------------------------------------------------------------------
// Google Calendar sync debug log
//
// The settings row only ever kept the last error *message*, which loses the
// thing you actually need when Google rejects a write: the HTTP status, the
// error.code/status/reason Google returns, and the event body we sent. This
// ring buffer records every sync trigger (including skipped ones, so you can
// tell "never fired" apart from "fired and failed") with the failing request
// payload attached.
// ---------------------------------------------------------------------------

const debugLogSettingKey = "googleCalendarDebugLogJson";
const debugEnabledSettingKey = "googleCalendarDebugEnabled";
const googleCalendarSourcePreferencesSettingKey = "googleCalendarSourcePreferencesJson";
const debugLogMaxEntries = 30;
const debugLogMaxBytes = 220_000;
const googleCalendarSourceListMaxPages = 4;

export type GoogleCalendarDebugRequest = {
  method: string;
  url: string;
  calendarId: string;
  eventId: string;
  itemId: string;
  itemLabel: string;
  payload: unknown;
};

export type GoogleCalendarDebugError = {
  stage: string;
  message: string;
  httpStatus: number;
  httpStatusText: string;
  googleCode: string;
  googleStatus: string;
  googleReason: string;
  googleDomain: string;
  googleMessage: string;
  googleErrors: unknown[];
  providerCode: string;
  rawBody: string;
};

export type GoogleCalendarSourcePreference = {
  showOnClarity: boolean;
  showLabel: boolean;
};

export type GoogleCalendarSource = GoogleCalendarSourcePreference & {
  id: string;
  name: string;
  primary: boolean;
  hidden: boolean;
  accessRole: string;
};

export type GoogleCalendarDebugEntry = {
  id: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "success" | "failed" | "skipped";
  reason: string;
  stage: string;
  mode: "full" | "targeted";
  calendarId: string;
  accountEmail: string;
  itemCount: number;
  upserted: number;
  deleted: number;
  unchanged: number;
  retries: number;
  changes: Array<{ id: string; action: string }>;
  request: GoogleCalendarDebugRequest | null;
  requestIsSample: boolean;
  error: GoogleCalendarDebugError | null;
};

function debugLoggingEnabled(settings?: Record<string, string>) {
  return settings ? settings[debugEnabledSettingKey] !== "false" : true;
}

function safeJsonParse(text: string): any {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

/**
 * Pull the parts of a Google API error response that identify *which* failure
 * it is: `error.code` (numeric), `error.status` (PERMISSION_DENIED,
 * NOT_FOUND, ...) and `error.errors[0].reason` (invalidSharingRequest,
 * rateLimitExceeded, forbiddenForServiceAccounts, ...).
 */
function describeGoogleFailure(response: Response, text: string, parsed: any): GoogleCalendarDebugError {
  const googleError = parsed && typeof parsed === "object" ? parsed.error : undefined;
  const detail = Array.isArray(googleError?.errors) ? googleError.errors[0] : undefined;
  return {
    stage: "",
    message: "",
    httpStatus: response.status,
    httpStatusText: response.statusText || "",
    googleCode: String(googleError?.code ?? response.status),
    googleStatus: cleanString(googleError?.status, "", 80),
    googleReason: cleanString(detail?.reason, "", 120),
    googleDomain: cleanString(detail?.domain, "", 120),
    googleMessage: cleanString(typeof googleError === "string" ? googleError : googleError?.message, "", 600),
    googleErrors: Array.isArray(googleError?.errors) ? googleError.errors.slice(0, 5) : [],
    providerCode: "",
    rawBody: text.slice(0, 1500),
  };
}

export function googleCalendarDebugErrorFromUnknown(error: any, fallbackStage: string) {
  return debugErrorFromUnknown(error, fallbackStage);
}

function debugErrorFromUnknown(error: any, fallbackStage: string): GoogleCalendarDebugError {
  const base: GoogleCalendarDebugError = error?.googleFailure
    ? { ...error.googleFailure }
    : {
        stage: "",
        message: "",
        httpStatus: Number(error?.status) || 0,
        httpStatusText: "",
        googleCode: "",
        googleStatus: "",
        googleReason: "",
        googleDomain: "",
        googleMessage: "",
        googleErrors: [],
        providerCode: "",
        rawBody: "",
      };
  base.stage = cleanString(error?.debugStage, fallbackStage, 60);
  base.message = cleanString(error instanceof Error ? error.message : String(error || ""), "Google Calendar sync failed.", 600);
  // getGoogleAccessToken / the provider store tag their own failures
  // (GOOGLE_TOKEN_REFRESH_FAILED, GOOGLE_SCOPE_MISSING, ...).
  base.providerCode = cleanString(error?.code, base.providerCode, 80);
  return base;
}

async function readGoogleCalendarDebugEntries(settings?: Record<string, string>): Promise<GoogleCalendarDebugEntry[]> {
  const map = settings || (await readSettings());
  const entries = parseJson<GoogleCalendarDebugEntry[]>(map[debugLogSettingKey], []);
  return Array.isArray(entries) ? entries : [];
}

function trimDebugEntries(entries: GoogleCalendarDebugEntry[]) {
  let trimmed = entries.slice(0, debugLogMaxEntries);
  while (trimmed.length > 1 && JSON.stringify(trimmed).length > debugLogMaxBytes) {
    trimmed = trimmed.slice(0, trimmed.length - 1);
  }
  return trimmed;
}

/** Baseline entry so every recording site only spells out what it actually knows. */
function newDebugEntry(overrides: Partial<Omit<GoogleCalendarDebugEntry, "id">>): Omit<GoogleCalendarDebugEntry, "id"> {
  return {
    trigger: "unknown",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 0,
    outcome: "skipped",
    reason: "",
    stage: "",
    mode: "targeted",
    calendarId: "",
    accountEmail: "",
    itemCount: 0,
    upserted: 0,
    deleted: 0,
    unchanged: 0,
    retries: 0,
    changes: [],
    request: null,
    requestIsSample: false,
    error: null,
    ...overrides,
  };
}

async function recordGoogleCalendarDebugEntry(
  entry: Omit<GoogleCalendarDebugEntry, "id">,
  settings?: Record<string, string>,
) {
  try {
    if (!debugLoggingEnabled(settings)) return;
    const existing = await readGoogleCalendarDebugEntries();
    const next = trimDebugEntries([{ id: randomUUID(), ...entry }, ...existing]);
    await setSetting(debugLogSettingKey, JSON.stringify(next));
  } catch (error) {
    // The debug log must never be the reason a sync fails.
    console.error("google_calendar_sync:debug_log_write_failed", error);
  }
}

export async function getGoogleCalendarDebugLog() {
  const settings = await readSettings();
  return {
    ok: true,
    enabled: debugLoggingEnabled(settings),
    maxEntries: debugLogMaxEntries,
    autoSync: googleCalendarManualSyncOnly ? false : settings.googleCalendarAutoSync !== "false",
    manualOnly: googleCalendarManualSyncOnly,
    calendarId: settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"),
    entries: await readGoogleCalendarDebugEntries(settings),
  };
}

export async function clearGoogleCalendarDebugLog() {
  await setSetting(debugLogSettingKey, "[]");
  return getGoogleCalendarDebugLog();
}

export async function setGoogleCalendarDebugEnabled(enabled: boolean) {
  await setSetting(debugEnabledSettingKey, enabled ? "true" : "false");
  return getGoogleCalendarDebugLog();
}

function cleanUrl(value: unknown, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : fallback;
  } catch {
    return fallback;
  }
}

function cleanBookingLocationSnapshot(raw: any, fallback: any = {}) {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  const base = source?.name ? source : fallback;
  if (!base?.name) return null;
  return {
    locationId: cleanString(base.locationId, "", 120) || undefined,
    name: cleanString(base.name, fallback.name || "", 140),
    shortName: cleanString(base.shortName, fallback.shortName || base.name || "", 80) || undefined,
    address: cleanString(base.address, "", 240) || undefined,
    mapUrl: cleanUrl(base.mapUrl, "") || undefined,
    arrivalInstructions: cleanString(base.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(base.publicNotes, "", 500) || undefined,
    timezone: cleanString(base.timezone, fallback.timezone || "", 80) || undefined,
  };
}

function bookingLocationDisplay(location: any) {
  return [location?.name, location?.address].filter(Boolean).join(" · ");
}

function configuredRedirectUri(req?: Request) {
  const configured = env("GOOGLE_CALENDAR_REDIRECT_URI", "");
  if (configured) return configured;
  if (!req) return "https://claritygolf.app/api/google-calendar/callback";
  const url = new URL(req.url);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalHost) return "https://claritygolf.app/api/google-calendar/callback";
  return `${url.origin}/api/google-calendar/callback`;
}

/**
 * Which Google app Clarity is, and where Google should return to.
 *
 * Calendar may have its own Google app one day — that is what the
 * GOOGLE_CALENDAR_* pair is reserved for — so it still wins when set. What
 * changed is the fallback: when it is absent, the shared credentials every
 * other Google feature already uses are taken instead of nothing at all.
 *
 * Having no fallback was invisible and nasty (found 20 Aug 2026). An install
 * with only the shared pair set had a perfectly working token refresh, because
 * that path already read the shared credentials — while this screen reported
 * "Needs OAuth credentials" and Connect Google could not build an auth URL at
 * all. The connection looked alive, every write was failing on scope, and the
 * one action that would have fixed it was unreachable from the UI.
 *
 * The redirect URI is deliberately NOT shared: Google returns to
 * /api/google-calendar/callback here and /api/google-drive/callback for Drive,
 * and those are separately registered with Google.
 *
 * The redirect URI does not depend on having a Request either (found 28 Aug
 * 2026). It used to fall back to the bare env var when req was absent, so every
 * status read taken off a request — the calendar-state payload, the response to
 * saving source visibility — came back with an empty redirect URI and therefore
 * configured: false. The settings screen applies whichever status arrives last,
 * so a correct status from GET /api/google-calendar/status was routinely
 * overwritten by a req-less one and the screen flipped to "Needs OAuth
 * credentials" with Connect Google greyed out, on an install whose credentials
 * were fine. Drive already had this fallback; Calendar now matches.
 */
export function googleConfig(req?: Request) {
  const shared = getClarityCloudGoogleConfig(req);
  return {
    clientId: env("GOOGLE_CALENDAR_CLIENT_ID", "") || shared.clientId,
    clientSecret: env("GOOGLE_CALENDAR_CLIENT_SECRET", "") || shared.clientSecret,
    redirectUri: configuredRedirectUri(req),
  };
}

function cleanCalendarId(value: unknown) {
  return cleanString(value, "primary", 320) || "primary";
}

async function listGoogleCalendarSources(accessToken: string) {
  const sources: GoogleCalendarSource[] = [];
  let pageToken = "";
  for (let page = 0; page < googleCalendarSourceListMaxPages; page += 1) {
    const query = new URLSearchParams({
      maxResults: "250",
      showHidden: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await googleCalendarRequest(accessToken, `/users/me/calendarList?${query}`);
    for (const item of Array.isArray(data?.items) ? data.items : []) {
      const id = cleanString(item?.id, "", 320);
      if (!id || item?.deleted === true) continue;
      sources.push({
        id,
        name: cleanString(item?.summaryOverride, "", 200) || cleanString(item?.summary, id, 200) || id,
        primary: item?.primary === true,
        hidden: item?.hidden === true,
        accessRole: cleanString(item?.accessRole, "", 80),
        showOnClarity: false,
        showLabel: false,
      });
    }
    pageToken = cleanString(data?.nextPageToken, "", 320);
    if (!pageToken) break;
  }
  return sources.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

export async function getGoogleCalendarSyncStatus(req?: Request) {
  const settings = await readSettings();
  const config = googleConfig(req);
  const configured = Boolean(config.clientId && config.clientSecret && config.redirectUri);
  const accountId = resolveGoogleAccountId(settings);
  const connection = await loadGoogleProviderConnection(accountId);
  const providerStatus = publicGoogleProviderStatus(connection, googleScopes);
  const legacyMigrationRequired = Boolean(settings.googleCalendarRefreshToken);
  const connected = Boolean(
    connection?.calendarEnabled &&
      connection.connectionStatus === "connected" &&
      hasGoogleScopes(connection, googleScopes)
  );
  const calendarId = settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary");
  const sourcePreferences = readGoogleCalendarSourcePreferenceMap(settings);
  let sources: GoogleCalendarSource[] = [];
  let sourceListError = "";
  if (connected) {
    try {
      sources = applyGoogleCalendarSourcePreferences(
        await listGoogleCalendarSources(await getGoogleAccessToken(accountId, googleScopes)),
        sourcePreferences,
        calendarId,
      );
    } catch (error) {
      sourceListError = error instanceof Error ? error.message.slice(0, 300) : "Google calendar sources could not be loaded.";
    }
  }
  return {
    configured,
    connected,
    accountId,
    calendarId,
    autoSync: googleCalendarManualSyncOnly ? false : settings.googleCalendarAutoSync !== "false",
    manualOnly: googleCalendarManualSyncOnly,
    accountEmail: providerStatus.accountEmail || settings.googleCalendarAccountEmail || "",
    lastSyncAt: settings.googleCalendarLastSyncAt || "",
    lastSyncStatus: legacyMigrationRequired ? "migration_required" : settings.googleCalendarLastSyncStatus || "",
    lastSyncError: legacyMigrationRequired
      ? "Legacy Google Calendar token must be migrated to encrypted provider storage."
      : providerStatus.lastErrorCode || settings.googleCalendarLastSyncError || "",
    connectedAt: providerStatus.connectedAt || settings.googleCalendarConnectedAt || "",
    redirectUri: config.redirectUri,
    scope: googleScopes.join(" "),
    grantedScopes: providerStatus.grantedScopes,
    missingScopes: providerStatus.missingScopes,
    connectionStatus: providerStatus.connectionStatus,
    legacyMigrationRequired,
    sources,
    sourceListError,
  };
}

export async function updateGoogleCalendarSyncSettings(body: any) {
  const currentSettings = await readSettings();
  const values: Record<string, unknown> = {};
  const calendarId = Object.prototype.hasOwnProperty.call(body || {}, "calendarId")
    ? cleanCalendarId(body.calendarId)
    : cleanCalendarId(currentSettings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"));
  if (Object.prototype.hasOwnProperty.call(body || {}, "calendarId")) {
    values.googleCalendarId = calendarId;
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "autoSync")) {
    values.googleCalendarAutoSync = googleCalendarManualSyncOnly ? "false" : body.autoSync === false ? "false" : "true";
  } else if (googleCalendarManualSyncOnly) {
    values.googleCalendarAutoSync = "false";
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "sourcePreferences")) {
    const accountId = resolveGoogleAccountId(currentSettings);
    let knownSources: GoogleCalendarSource[] = [];
    const connection = await loadGoogleProviderConnection(accountId);
    if (
      connection?.calendarEnabled &&
      connection.connectionStatus === "connected" &&
      hasGoogleScopes(connection, googleScopes)
    ) {
      try {
        knownSources = await listGoogleCalendarSources(await getGoogleAccessToken(accountId, googleScopes));
      } catch {
        knownSources = [];
      }
    }
    values[googleCalendarSourcePreferencesSettingKey] = JSON.stringify(
      sourcePreferenceMapForStorage(body.sourcePreferences, knownSources, calendarId),
    );
  }
  await setSettings(values);
  return getGoogleCalendarSyncStatus();
}

export async function createGoogleCalendarAuthUrl(req: Request) {
  const config = googleConfig(req);
  if (!config.clientId || !config.clientSecret) {
    throw Object.assign(new Error("Google Calendar OAuth is not configured."), { status: 400 });
  }
  const state = randomUUID().replaceAll("-", "");
  const settings = await readSettings();
  const accountId = resolveGoogleAccountId(settings);
  await setSettings({
    googleCalendarOAuthState: state,
    googleCalendarOAuthAccountId: accountId,
    googleCalendarOAuthStartedAt: nowIso(),
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", googleScopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return {
    authUrl: url.toString(),
    redirectUri: config.redirectUri,
    scope: googleScopes.join(" "),
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
    });
  }
  return data;
}

async function userEmail(accessToken: string) {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = response.ok ? await response.json() : {};
    return cleanString(data.email, "", 180);
  } catch {
    return "";
  }
}

export async function finishGoogleCalendarOAuth(req: Request) {
  const url = new URL(req.url);
  const oauthError = cleanString(url.searchParams.get("error"), "", 200);
  const oauthErrorDescription = cleanString(url.searchParams.get("error_description"), "", 600);
  if (oauthError) {
    throw Object.assign(new Error(oauthErrorDescription || oauthError), { status: 400 });
  }
  const code = cleanString(url.searchParams.get("code"), "", 2000);
  const state = cleanString(url.searchParams.get("state"), "", 200);
  if (!code || !state) {
    throw Object.assign(new Error("Google did not return the required authorization code."), { status: 400 });
  }
  const settings = await readSettings();
  const expectedState = settings.googleCalendarOAuthState || "";
  if (!expectedState || state !== expectedState) {
    throw Object.assign(new Error("Google Calendar connection could not be verified."), { status: 400 });
  }
  const startedAt = Date.parse(settings.googleCalendarOAuthStartedAt || "");
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > 15 * 60 * 1000) {
    throw Object.assign(new Error("Google Calendar connection expired. Start again."), { status: 400 });
  }
  const accountId = settings.googleCalendarOAuthAccountId || resolveGoogleAccountId(settings);

  const config = googleConfig(req);
  const token = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
    grant_type: "authorization_code",
  });
  const email = token.access_token ? await userEmail(token.access_token) : "";
  await saveGoogleAuthorization({
    accountId,
    refreshToken: cleanString(token.refresh_token, "", 4000) || undefined,
    grantedScopes: cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean).length
      ? cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean)
      : googleScopes,
    // Google told us; anything else is a guess and must not overwrite the truth.
    scopesFromProvider: cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean).length > 0,
    providerEmail: email || settings.googleCalendarAccountEmail || "",
    enableCalendar: true,
  });
  await setSettings({
    googleCalendarRefreshToken: "",
    googleCalendarAccountEmail: email,
    googleCalendarConnectedAt: nowIso(),
    googleCalendarAutoSync: "true",
    googleCalendarOAuthState: "",
    googleCalendarOAuthAccountId: "",
    googleCalendarOAuthStartedAt: "",
    googleCalendarLastSyncStatus: "connected",
    googleCalendarLastSyncError: "",
  });
  return getGoogleCalendarSyncStatus(req);
}

export async function disconnectGoogleCalendar(req?: Request) {
  const settings = await readSettings();
  await disconnectGoogleService(resolveGoogleAccountId(settings), "calendar");
  await setSettings({
    googleCalendarRefreshToken: "",
    googleCalendarAccountEmail: "",
    googleCalendarConnectedAt: "",
    googleCalendarEventMapJson: "{}",
    googleCalendarLastSyncStatus: "disconnected",
    googleCalendarLastSyncError: "",
  });
  return getGoogleCalendarSyncStatus(req);
}

export async function migrateLegacyGoogleCalendarConnection(req?: Request) {
  const result = await migrateLegacyGoogleCalendarToken();
  return {
    ...result,
    status: await getGoogleCalendarSyncStatus(req),
  };
}

function rowToItem(row: any) {
  return {
    id: row.id,
    kind: row.kind === "block" ? "block" : "appointment",
    origin: row.origin || "",
    week: Number(row.week ?? 0),
    day: Number(row.day ?? 0),
    start: Number(row.start ?? 0),
    duration: Number(row.duration ?? 0),
    coachId: row.coach_id || "",
    locationId: row.location_id || cleanBookingLocationSnapshot(row.location)?.locationId || "",
    serviceId: row.service_id || "",
    client: row.client || "",
    title: row.title || row.client || "Booking",
    phone: row.phone || "",
    email: row.email || "",
    note: row.note || "",
    status: row.status || "",
    coach: row.coach || undefined,
    location: cleanBookingLocationSnapshot(row.location),
  };
}

function isCancelledGroupSessionItem(item: any) {
  return (
    item?.kind === "block" &&
    Boolean(item?.serviceId || item?.service_id) &&
    (item?.note === "__cancelled_group_session__" || item?.title === "Cancelled group session")
  );
}

/**
 * Whether this item should hold time on the coach's Google calendar.
 *
 * A cancelled or no-show booking stays on the Clarity calendar as a record but
 * is no longer busy time, and leaving it in Google would hold an hour the coach
 * is free to fill. Falling out of this predicate is what deletes the event on
 * the next sync, so cancelling in Clarity clears the Google slot.
 */
export function isBusyGoogleItem(item: any) {
  if (!item) return false;
  if (isCancelledGroupSessionItem(item)) return false;
  // Never send back what we read in. A block imported from this same calendar
  // already exists in Google as the event it came from; pushing it would
  // duplicate that event, and the next import would read the duplicate and
  // make another. This is the second half of the loop guard — the first is
  // in google-calendar-import.mts, which refuses to import Clarity's own
  // events. Either half alone still loops, one hop slower.
  if (item.origin === GOOGLE_IMPORT_ORIGIN) return false;
  return item.status !== "cancelled" && item.status !== "no_show";
}

function serviceName(serviceId: string, services: any[]) {
  return services.find((service) => service?.id === serviceId)?.name || "Golf Lesson";
}

function defaultLocationFromAccount(account: ReturnType<typeof accountFromSettings>) {
  return {
    id: "default-location",
    name: account.venueName,
    shortName: account.venueShortName || account.venueName,
    address: "",
    timezone: account.timezone,
    active: true,
    archived: false,
    isDefault: true,
  };
}

function resolveLocation(item: any, service: any, locations: any[], account: ReturnType<typeof accountFromSettings>) {
  const activeLocations = Array.isArray(locations)
    ? locations.filter((location) => location?.active !== false && location?.archived !== true)
    : [];
  const byItem = activeLocations.find((location) => location.id && location.id === item?.locationId);
  const byService = activeLocations.find((location) => location.id && location.id === service?.locationId);
  const fallback = activeLocations.find((location) => location.isDefault) || activeLocations[0] || defaultLocationFromAccount(account);
  return cleanBookingLocationSnapshot(item.location, byItem || byService || fallback);
}

function dateForSlot(week: number, day: number) {
  const date = new Date(baseWeekStart);
  date.setUTCDate(baseWeekStart.getUTCDate() + week * 7 + day);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function googleLocalDateTime(week: number, day: number, minutes: number) {
  const date = dateForSlot(week, day);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(hour)}:${pad(minute)}:00`;
}

/**
 * Like googleLocalDateTime, but for a time measured from the start of a weekday
 * that may run past midnight — an unavailable span from Friday evening to
 * Monday morning is 3900 minutes into Friday, not hour 65 of it.
 */
function googleSpanDateTime(day: number, minutes: number) {
  const dayOffset = Math.floor(minutes / (24 * 60));
  return googleLocalDateTime(0, day + dayOffset, minutes - dayOffset * 24 * 60);
}

function googleEventId(itemId: string) {
  return `cg${createHash("sha256").update(itemId).digest("hex").slice(0, 30)}`;
}

function accountFromSettings(settings: Record<string, string>) {
  return {
    businessName: settings.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: settings.accountVenueName || env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: settings.accountVenueShortName || env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: settings.accountContactEmail || env("CLARITY_CONTACT_EMAIL", ""),
  };
}

function eventSummary(item: any, account: ReturnType<typeof accountFromSettings>, services: any[]) {
  if (item.kind === "unavailable") return `Unavailable - ${account.businessName}`;
  if (item.kind === "block") return `Busy - ${account.businessName}`;
  return `${item.client || item.title} - ${serviceName(item.serviceId, services)}`;
}

function eventDescription(item: any, services: any[], location: any) {
  if (item.kind === "unavailable") return "Outside booking hours. Set by your Clarity availability.";
  const rows =
    item.kind === "block"
      ? ["Blocked time", item.note]
      : [
          `Service: ${serviceName(item.serviceId, services)}`,
          `Client: ${item.client || item.title}`,
          location?.address ? `Address: ${location.address}` : "",
          location?.arrivalInstructions ? `Arrival: ${location.arrivalInstructions}` : "",
          location?.mapUrl ? `Map: ${location.mapUrl}` : "",
          item.phone ? `Phone: ${item.phone}` : "",
          item.email ? `Email: ${item.email}` : "",
          item.note,
        ];
  return [...rows.filter(Boolean), "", `Clarity booking ID: ${item.id}`].join("\n");
}

function googleEventForItem(item: any, settings: Record<string, string>, services: any[], locations: any[], eventId: string) {
  const account = accountFromSettings(settings);
  const service = services.find((candidate) => candidate?.id === item.serviceId);
  const location = resolveLocation(item, service, locations, account);
  const week = Number(item.week ?? 0);
  const timezone = location?.timezone || account.timezone;
  // An unavailable stretch is a property of the week, not of a venue. Naming a
  // location on it would put an address on hours the coach is not there.
  const unavailable = item.kind === "unavailable";
  const start = unavailable
    ? googleSpanDateTime(item.day, item.start)
    : googleLocalDateTime(week, item.day, item.start);
  const end = unavailable
    ? googleSpanDateTime(item.day, item.start + item.duration)
    : googleLocalDateTime(week, item.day, item.start + item.duration);
  return {
    id: eventId,
    summary: eventSummary(item, account, services),
    description: eventDescription(item, services, location),
    location: unavailable ? "" : bookingLocationDisplay(location),
    start: { dateTime: start, timeZone: timezone },
    end: { dateTime: end, timeZone: timezone },
    // Availability is a weekly pattern with no dates in it, so the time it
    // leaves over repeats weekly too. A handful of recurring events cover every
    // hour indefinitely; walking a horizon would be hundreds that go stale.
    ...(unavailable ? { recurrence: ["RRULE:FREQ=WEEKLY"] } : {}),
    transparency: "opaque",
    visibility: item.kind === "appointment" ? "default" : "private",
    extendedProperties: {
      private: {
        clarityBooking: "true",
        clarityBookingId: item.id,
        clarityKind: item.kind,
      },
    },
  };
}

function googleEventFingerprint(event: any) {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

/**
 * How far either side of today the busy import looks.
 *
 * Backwards at all, because a lesson moved earlier this week still has to stop
 * holding its old slot. Not far backwards, because past time cannot be
 * double-booked and every extra week is events to page through.
 */
const busyImportWeeksBack = 1;
const busyImportWeeksAhead = 12;
/** Pages of 250. Clarity's own recurring "Unavailable" events expand into a
 * lot of instances inside the window, and they all arrive before being
 * discarded, so the ceiling has to allow for them. */
const busyImportMaxPages = 6;

async function listGoogleEvents(accessToken: string, calendarId: string, timeMin: string, timeMax: string) {
  const events: GoogleEvent[] = [];
  let pageToken = "";
  for (let page = 0; page < busyImportMaxPages; page += 1) {
    const query = new URLSearchParams({
      timeMin,
      timeMax,
      // Expand recurring events into their instances: a weekly commitment has
      // to hold each of its own slots, not one slot forever.
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await googleCalendarRequest(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events?${query}`);
    events.push(...(Array.isArray(data?.items) ? data.items : []));
    pageToken = String(data?.nextPageToken || "");
    if (!pageToken) break;
  }
  return { events, truncated: Boolean(pageToken) };
}

/**
 * Pulls the coach's other commitments in as read-only busy blocks.
 *
 * Everything Clarity did not write becomes a block: no client, no lesson type,
 * no price, and `origin` set so the UI refuses to move or resize it and the
 * outbound sync refuses to send it back.
 *
 * Failure here must never fail the outbound sync. Pushing lessons to Google is
 * the job that matters; knowing about a Golf HQ commitment is the bonus. The
 * caller wraps this, and the outcome is reported either way rather than
 * swallowed — a silent import is how a broken sync hides for three days.
 */
async function importGoogleBusyBlocks(accessToken: string, calendarId: string, settings: Record<string, string>) {
  const account = accountFromSettings(settings);
  const now = new Date();
  const timeMin = new Date(now.getTime() - busyImportWeeksBack * 7 * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + busyImportWeeksAhead * 7 * 86_400_000).toISOString();
  const sourcePreferences = readGoogleCalendarSourcePreferenceMap(settings);
  const sources = applyGoogleCalendarSourcePreferences(await listGoogleCalendarSources(accessToken), sourcePreferences, calendarId);
  const visibleSources = sources.filter((source) => source.showOnClarity);
  let scanned = 0;
  let truncated = false;
  const wanted: ReturnType<typeof busyBlocksFromGoogleEvents> = [];
  for (const source of visibleSources) {
    const { events, truncated: sourceTruncated } = await listGoogleEvents(accessToken, source.id, timeMin, timeMax);
    scanned += events.length;
    truncated ||= sourceTruncated;
    wanted.push(
      ...busyBlocksFromGoogleEvents(events, account.timezone, {
        sourceId: source.id,
        sourceName: source.name,
        showLabel: source.showLabel,
      } satisfies GoogleCalendarSourceDisplay),
    );
  }

  // Only rows this import owns are ever read here, and therefore only they can
  // ever be deleted below. A lesson or a coach's own block is out of reach.
  const existingRows = (await supabase("calendar_items", {
    query: `select=id,week,day,start,duration,title,external_source&origin=eq.${encodeURIComponent(GOOGLE_IMPORT_ORIGIN)}`,
  })) as Array<Record<string, unknown>>;
  const plan = planBusyBlockImport(wanted, existingRows.map((row) => ({ ...row, id: String(row.id) })));

  // The coach owns their own diary, so the block files under the same account
  // and coach as everything else on this calendar.
  const accountSlug = settings.accountCalendarSlug || defaultAccountId();
  const rowFor = (block: (typeof wanted)[number]) => ({
    id: block.id,
    account_id: accountSlug,
    kind: "block",
    title: block.title,
    client: "",
    week: block.week,
    day: block.day,
    start: block.start,
    duration: block.duration,
    status: "booked",
    coach_id: accountSlug,
    service_id: "",
    person_id: "",
    location_id: "",
    note: "",
    origin: GOOGLE_IMPORT_ORIGIN,
    external_provider: GOOGLE_IMPORT_ORIGIN,
    external_booking_id: block.googleEventId,
    external_source: block.sourceId,
    external_updated_at: nowIso(),
    updated_at: nowIso(),
  });

  const writes = [...plan.create, ...plan.update].map(rowFor);
  if (writes.length) {
    await supabase("calendar_items?on_conflict=id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: writes,
    });
  }
  if (plan.deleteIds.length) {
    const list = plan.deleteIds.map((id) => `"${id}"`).join(",");
    await supabase("calendar_items", {
      method: "DELETE",
      query: `origin=eq.${encodeURIComponent(GOOGLE_IMPORT_ORIGIN)}&id=in.(${encodeURIComponent(list)})`,
    });
  }
  return {
    scanned,
    imported: plan.create.length,
    updated: plan.update.length,
    removed: plan.deleteIds.length,
    unchanged: plan.unchanged,
    truncated,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      showOnClarity: source.showOnClarity,
      showLabel: source.showLabel,
    })),
  };
}

/** Tag an in-flight error with the request that produced it, for the debug log. */
function attachDebugRequest(error: any, request: GoogleCalendarDebugRequest, stage: string) {
  if (error && typeof error === "object") {
    error.debugRequest = request;
    error.debugStage = error.debugStage || stage;
  }
  return error;
}

function describeGoogleRequest(
  method: string,
  path: string,
  calendarId: string,
  eventId: string,
  event: any,
  debugMeta: { itemId: string; itemLabel: string },
): GoogleCalendarDebugRequest {
  return {
    method,
    url: `https://www.googleapis.com/calendar/v3${path}`,
    calendarId,
    eventId,
    itemId: debugMeta.itemId,
    itemLabel: debugMeta.itemLabel,
    payload: event,
  };
}

async function createGoogleEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: any,
  debugMeta: { itemId: string; itemLabel: string },
  budget?: GoogleRetryBudget,
) {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const insertPath = `/calendars/${encodedCalendarId}/events?sendUpdates=none`;
  const replacePath = `/calendars/${encodedCalendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=none`;
  const insertBody = { ...event, id: eventId };
  try {
    return await googleCalendarRequest(
      accessToken,
      insertPath,
      { method: "POST", body: JSON.stringify(insertBody) },
      budget,
    );
  } catch (error: any) {
    // A previous attempt may have created the deterministic id before its map
    // was persisted. Recover with one replacement rather than creating a duplicate.
    if (error?.status !== 409) {
      throw attachDebugRequest(
        error,
        describeGoogleRequest("POST", insertPath, calendarId, eventId, insertBody, debugMeta),
        "create_insert",
      );
    }
    try {
      return await googleCalendarRequest(
        accessToken,
        replacePath,
        { method: "PUT", body: JSON.stringify(event) },
        budget,
      );
    } catch (replaceError: any) {
      throw attachDebugRequest(
        replaceError,
        describeGoogleRequest("PUT", replacePath, calendarId, eventId, event, debugMeta),
        "create_replace",
      );
    }
  }
}

// Google throttles bursts of writes to a single calendar and answers with
// 403 rateLimitExceeded (domain usageLimits) rather than 429. The documented
// remedy is exponential backoff with jitter, so retry those in place instead
// of failing the whole run. A daily quotaExceeded is NOT retried -- waiting
// milliseconds cannot clear a 24h quota.
const retryableGoogleReasons = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const maxGoogleRetriesPerRequest = 3;
// Whole-run ceiling on time spent sleeping. Netlify kills the function well
// before Google stops throttling, so cap the total rather than per request.
const googleRetryBudgetMs = 8000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableGoogleFailure(status: number, failure: Pick<GoogleCalendarDebugError, "googleReason">) {
  if (status === 429) return true;
  if (status >= 500) return true;
  return status === 403 && retryableGoogleReasons.has(failure.googleReason);
}

/** Per-run retry accounting, so one slow calendar cannot stall the function. */
type GoogleRetryBudget = { spentMs: number; retries: number };

async function googleCalendarRequest(
  accessToken: string,
  path: string,
  options: RequestInit = {},
  budget?: GoogleRetryBudget,
) {
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  const method = options.method || "GET";

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    const data = safeJsonParse(text);
    if (response.ok) return data ?? {};

    const failure = describeGoogleFailure(response, text, data);
    const canRetry =
      attempt < maxGoogleRetriesPerRequest &&
      isRetryableGoogleFailure(response.status, failure) &&
      (!budget || budget.spentMs < googleRetryBudgetMs);
    if (canRetry) {
      // 500ms, 1s, 2s, plus jitter so parallel callers do not resynchronise.
      const delay = Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250);
      if (budget) {
        budget.spentMs += delay;
        budget.retries += 1;
      }
      await sleep(delay);
      continue;
    }

    // Google's own message when it sends JSON, otherwise the status line --
    // a 502 HTML error page used to blow up in JSON.parse and mask the status.
    const message =
      failure.googleMessage ||
      `Google Calendar ${method} failed ${response.status}${failure.httpStatusText ? ` ${failure.httpStatusText}` : ""}`;
    throw Object.assign(new Error(message), {
      status: response.status,
      googleError: data,
      googleFailure: failure,
      googleRequest: { method, url },
      googleRetries: budget?.retries || attempt,
    });
  }
}

async function upsertGoogleEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: any,
  existsInMap: boolean,
  debugMeta: { itemId: string; itemLabel: string },
  budget?: GoogleRetryBudget,
) {
  if (!existsInMap) return createGoogleEvent(accessToken, calendarId, eventId, event, debugMeta, budget);
  const updatePath = `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`;
  try {
    return await googleCalendarRequest(accessToken, updatePath, { method: "PUT", body: JSON.stringify(event) }, budget);
  } catch (error: any) {
    throw attachDebugRequest(
      error,
      describeGoogleRequest("PUT", updatePath, calendarId, eventId, event, debugMeta),
      "upsert_update",
    );
  }
}

async function deleteGoogleEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  itemId = "",
  budget?: GoogleRetryBudget,
) {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);
  const path = `/calendars/${encodedCalendarId}/events/${encodedEventId}?sendUpdates=none`;
  try {
    await googleCalendarRequest(accessToken, path, { method: "DELETE" }, budget);
    return true;
  } catch (error: any) {
    if (error?.status === 404 || error?.status === 410) return false;
    throw attachDebugRequest(
      error,
      describeGoogleRequest("DELETE", path, calendarId, eventId, null, {
        itemId,
        itemLabel: "Removed booking",
      }),
      "delete",
    );
  }
}

/**
 * The coach's unavailable stretches, shaped like calendar items so they travel
 * the same upsert-and-diff path as bookings. Their ids come from where the span
 * sits in the week, which is what lets the delete pass retire the ones that
 * stop being unavailable — without it, every edit to availability would leave
 * its old blocks behind in Google.
 *
 * Anchored to week 0 and repeating weekly, so they cover every hour from here
 * on rather than a horizon that needs walking forward, and the event body never
 * changes just because time passed.
 */
function unavailableSyncItems(settings: Record<string, string>) {
  const availability = parseJson<any[][]>(settings.availabilityJson, []);
  return unavailableSpans(availability).map((span) => ({
    id: span.id,
    kind: "unavailable" as const,
    week: 0,
    day: span.day,
    start: span.start,
    duration: span.durationMinutes,
    title: "Unavailable",
    client: "",
    serviceId: "",
    note: "",
    status: "",
  }));
}

async function calendarSyncPayload() {
  const [settingsRows, itemRows] = await Promise.all([
    supabase("settings", { query: "select=key,value" }),
    supabase("calendar_items", { query: "select=*&order=week.asc,day.asc,start.asc,id.asc" }),
  ]);
  const settings = settingMap(settingsRows);
  return {
    settings,
    items: [...itemRows.map(rowToItem).filter(isBusyGoogleItem), ...unavailableSyncItems(settings)],
    services: parseJson(settings.servicesJson, defaultServices),
    locations: parseJson(settings.locationsJson, []),
  };
}

export async function syncGoogleCalendarNow(trigger = "manual_sync_now") {
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const { settings, items, services, locations } = await calendarSyncPayload();
  const status = await getGoogleCalendarSyncStatus();
  const calendarId = cleanCalendarId(settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"));

  const finishEntry = (outcome: GoogleCalendarDebugEntry["outcome"], detail: Partial<Omit<GoogleCalendarDebugEntry, "id">> = {}) =>
    newDebugEntry({
      trigger,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - startedAtMs,
      outcome,
      mode: "full",
      calendarId,
      accountEmail: status.accountEmail || "",
      itemCount: items.length,
      ...detail,
    });

  const skip = async (reason: string) => {
    await recordGoogleCalendarDebugEntry(finishEntry("skipped", { reason, stage: "preflight" }), settings);
    return { ...status, ok: false, skipped: true, reason };
  };
  if (!status.configured) return skip("google_oauth_not_configured");
  if (status.legacyMigrationRequired) return skip("google_calendar_token_migration_required");
  if (!status.connected) return skip("google_calendar_not_connected");

  const previousMap = parseJson<Record<string, string>>(settings.googleCalendarEventMapJson, {});
  const previousHashMap = parseJson<Record<string, string>>(settings.googleCalendarEventHashMapJson, {});
  const nextMap: Record<string, string> = {};
  const nextHashMap: Record<string, string> = {};
  // Even a clean run keeps one representative event body, so you can inspect
  // what Clarity sends without having to break the sync first.
  let sampleRequest: GoogleCalendarDebugRequest | null = null;
  let upserted = 0;
  let deleted = 0;
  let unchanged = 0;
  let stage = "access_token";
  const retryBudget: GoogleRetryBudget = { spentMs: 0, retries: 0 };
  // Held rather than resolved inline, because the outcome of this run has to
  // be recorded against the same connection whether it succeeds or fails.
  const accountId = resolveGoogleAccountId(settings);

  // Partial progress has to survive a mid-run failure. Without this, events
  // already created in Google are absent from the stored map, so the next run
  // POSTs them again, takes a 409, and recovers with a PUT -- two requests per
  // item instead of none, which makes each retry hit the rate limit sooner
  // than the last.
  const persistProgress = async (extra: Record<string, unknown>) =>
    setSettings({
      googleCalendarId: calendarId,
      googleCalendarEventMapJson: JSON.stringify({ ...previousMap, ...nextMap }),
      googleCalendarEventHashMapJson: JSON.stringify({ ...previousHashMap, ...nextHashMap }),
      ...extra,
    });

  try {
    const accessToken = await getGoogleAccessToken(accountId, googleScopes);

    stage = "upsert";
    for (const item of items) {
      const eventId = previousMap[item.id] || googleEventId(item.id);
      const event = googleEventForItem(item, settings, services, locations, eventId);
      const exists = Boolean(previousMap[item.id]);
      const fingerprint = googleEventFingerprint(event);
      // The targeted path already did this; the full rebuild did not, so
      // "Sync now" re-sent every booking on every press and burned the
      // per-calendar write quota even when nothing had changed.
      if (exists && previousHashMap[item.id] === fingerprint) {
        nextMap[item.id] = previousMap[item.id];
        nextHashMap[item.id] = fingerprint;
        unchanged += 1;
        continue;
      }
      if (!sampleRequest) {
        sampleRequest = describeGoogleRequest(
          exists ? "PUT" : "POST",
          exists
            ? `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`
            : `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
          calendarId,
          eventId,
          event,
          { itemId: item.id, itemLabel: event.summary },
        );
      }
      const result = await upsertGoogleEvent(
        accessToken,
        calendarId,
        eventId,
        event,
        exists,
        { itemId: item.id, itemLabel: event.summary },
        retryBudget,
      );
      nextMap[item.id] = result.id || eventId;
      nextHashMap[item.id] = fingerprint;
      upserted += 1;
    }

    stage = "delete";
    for (const [itemId, eventId] of Object.entries(previousMap)) {
      if (nextMap[itemId]) continue;
      if (await deleteGoogleEvent(accessToken, calendarId, eventId, itemId, retryBudget)) deleted += 1;
      // Whether Google deleted it just now or it was already gone (404), the
      // event no longer exists. Drop it from previousMap too: persistProgress
      // merges previousMap back in on a mid-run failure, and before this line
      // existed a rate-limited delete pass resurrected every entry it had
      // already cleared — so a large backlog of stale events was retried in
      // full every night, hit the rate limit again, and never shrank.
      delete previousMap[itemId];
      delete previousHashMap[itemId];
    }

    const syncedAt = nowIso();
    await setSettings({
      googleCalendarId: calendarId,
      googleCalendarEventMapJson: JSON.stringify(nextMap),
      googleCalendarEventHashMapJson: JSON.stringify(nextHashMap),
      googleCalendarLastSyncAt: syncedAt,
      googleCalendarLastSyncStatus: "synced",
      googleCalendarLastSyncError: "",
    });
    // Work actually landed in Google, so the connection has earned "connected"
    // — the only place that claim is made. A token refresh no longer makes it.
    await markConnectionHealthy(accountId).catch(() => undefined);

    // Then the other direction: the coach's other commitments come back as
    // read-only busy blocks. Deliberately after the push and deliberately
    // isolated — getting lessons into Google is the job, and a failure to read
    // Golf HQ's diary must not report the whole sync as broken. The outcome is
    // returned either way rather than swallowed.
    let busyImport: Record<string, unknown> | null = null;
    let busyImportError = "";
    if (settings.googleCalendarImportBusy !== "false") {
      try {
        busyImport = await importGoogleBusyBlocks(accessToken, calendarId, settings);
      } catch (error: any) {
        busyImportError = error instanceof Error ? error.message.slice(0, 300) : "Busy import failed.";
      }
    }
    await recordGoogleCalendarDebugEntry(
      finishEntry("success", {
        stage: "complete",
        upserted,
        deleted,
        unchanged,
        retries: retryBudget.retries,
        request: sampleRequest,
        requestIsSample: true,
      }),
      settings,
    );
    return {
      ...(await getGoogleCalendarSyncStatus()),
      ok: true,
      skipped: false,
      upserted,
      deleted,
      unchanged,
      syncedAt,
      busyImport,
      busyImportError,
    };
  } catch (error: any) {
    const debugError = debugErrorFromUnknown(error, stage);
    await persistProgress({
      googleCalendarLastSyncAt: nowIso(),
      googleCalendarLastSyncStatus: "failed",
      googleCalendarLastSyncError: debugError.message,
    });
    // A rejection that means the credential itself can no longer do the job is
    // recorded on the connection, so the health screen stops saying
    // "connected" while every write is refused. Rate limits and one-off
    // failures leave it alone.
    await noteGoogleApiFailure(accountId, debugError.httpStatus, debugError.googleReason).catch(() => undefined);
    await recordGoogleCalendarDebugEntry(
      finishEntry("failed", {
        stage: debugError.stage,
        upserted,
        deleted,
        unchanged,
        retries: retryBudget.retries,
        // The request that actually failed when we have it; otherwise the
        // first payload of the run (token failures never reach a request).
        request: error?.debugRequest || sampleRequest,
        requestIsSample: !error?.debugRequest && Boolean(sampleRequest),
        error: debugError,
      }),
      settings,
    );
    throw error;
  }
}

type GoogleCalendarChange = { id: string; action?: "upsert" | "delete" };
let googleCalendarChangeQueue: Promise<unknown> = Promise.resolve();

async function syncGoogleCalendarChangesNow(changes: GoogleCalendarChange[], trigger = "auto_sync") {
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const normalizedById = new Map<string, { id: string; action: "upsert" | "delete" }>();
  for (const change of changes) {
    const id = cleanString(change?.id, "", 140);
    if (!id) continue;
    normalizedById.set(id, {
      id,
      action: change?.action === "delete" ? "delete" : "upsert",
    });
  }
  const normalized = Array.from(normalizedById.values());

  const finishEntry = (
    outcome: GoogleCalendarDebugEntry["outcome"],
    calendarId: string,
    accountEmail: string,
    detail: Partial<Omit<GoogleCalendarDebugEntry, "id">> = {},
  ) =>
    newDebugEntry({
      trigger,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - startedAtMs,
      outcome,
      mode: "targeted",
      calendarId,
      accountEmail,
      itemCount: normalized.length,
      changes: normalized,
      ...detail,
    });

  if (!normalized.length) {
    const status = await getGoogleCalendarSyncStatus();
    await recordGoogleCalendarDebugEntry(
      finishEntry("skipped", status.calendarId, status.accountEmail || "", {
        reason: "no_google_relevant_changes",
        stage: "preflight",
      }),
    );
    return { ...status, ok: true, skipped: true, reason: "no_google_relevant_changes" };
  }

  const settings = await readSettings();
  const calendarId = cleanCalendarId(settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"));

  const skip = async (reason: string, ok: boolean) => {
    const status = await getGoogleCalendarSyncStatus();
    await recordGoogleCalendarDebugEntry(
      finishEntry("skipped", calendarId, status.accountEmail || "", { reason, stage: "preflight" }),
      settings,
    );
    return { ...status, ok, skipped: true, reason };
  };
  if (settings.googleCalendarAutoSync === "false") return skip("auto_sync_disabled", true);
  const status = await getGoogleCalendarSyncStatus();
  if (!status.configured) return skip("google_oauth_not_configured", false);
  if (status.legacyMigrationRequired) return skip("google_calendar_token_migration_required", false);
  if (!status.connected) return skip("google_calendar_not_connected", false);

  const eventMap = parseJson<Record<string, string>>(settings.googleCalendarEventMapJson, {});
  const hashMap = parseJson<Record<string, string>>(settings.googleCalendarEventHashMapJson, {});
  const services = parseJson(settings.servicesJson, defaultServices);
  const locations = parseJson(settings.locationsJson, []);
  let sampleRequest: GoogleCalendarDebugRequest | null = null;
  let upserted = 0;
  let deleted = 0;
  let unchanged = 0;
  let stage = "access_token";
  const retryBudget: GoogleRetryBudget = { spentMs: 0, retries: 0 };
  const accountId = resolveGoogleAccountId(settings);

  try {
    const accessToken = await getGoogleAccessToken(accountId, googleScopes);

    stage = "changes";
    for (const change of normalized) {
      let item: any = null;
      if (change.action !== "delete") {
        const rows = await supabase("calendar_items", {
          query: `select=*&id=eq.${encodeURIComponent(change.id)}&limit=1`,
        });
        item = rows[0] ? rowToItem(rows[0]) : null;
      }
      if (change.action === "delete" || !isBusyGoogleItem(item)) {
        const eventId = eventMap[change.id] || googleEventId(change.id);
        stage = "delete";
        if (await deleteGoogleEvent(accessToken, calendarId, eventId, change.id, retryBudget)) deleted += 1;
        delete eventMap[change.id];
        delete hashMap[change.id];
        continue;
      }

      const eventId = eventMap[item.id] || googleEventId(item.id);
      const event = googleEventForItem(item, settings, services, locations, eventId);
      const fingerprint = googleEventFingerprint(event);
      if (eventMap[item.id] && hashMap[item.id] === fingerprint) {
        unchanged += 1;
        continue;
      }
      const exists = Boolean(eventMap[item.id]);
      if (!sampleRequest) {
        sampleRequest = describeGoogleRequest(
          exists ? "PUT" : "POST",
          exists
            ? `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`
            : `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
          calendarId,
          eventId,
          event,
          { itemId: item.id, itemLabel: event.summary },
        );
      }
      stage = "upsert";
      const result = await upsertGoogleEvent(
        accessToken,
        calendarId,
        eventId,
        event,
        exists,
        { itemId: item.id, itemLabel: event.summary },
        retryBudget,
      );
      eventMap[item.id] = result.id || eventId;
      hashMap[item.id] = fingerprint;
      upserted += 1;
    }

    const syncedAt = nowIso();
    await setSettings({
      googleCalendarId: calendarId,
      googleCalendarEventMapJson: JSON.stringify(eventMap),
      googleCalendarEventHashMapJson: JSON.stringify(hashMap),
      googleCalendarLastSyncAt: syncedAt,
      googleCalendarLastSyncStatus: "synced",
      googleCalendarLastSyncError: "",
    });
    const noWork = upserted === 0 && deleted === 0;
    // Only claim the connection works when something actually reached Google.
    // A run with nothing to do proves nothing, so it makes no such claim.
    if (!noWork) await markConnectionHealthy(accountId).catch(() => undefined);
    await recordGoogleCalendarDebugEntry(
      finishEntry("success", calendarId, status.accountEmail || "", {
        stage: "complete",
        reason: noWork ? "unchanged" : "",
        upserted,
        deleted,
        unchanged,
        retries: retryBudget.retries,
        request: sampleRequest,
        requestIsSample: true,
      }),
      settings,
    );
    return {
      ...(await getGoogleCalendarSyncStatus()),
      ok: true,
      skipped: noWork,
      reason: noWork ? "unchanged" : undefined,
      upserted,
      deleted,
      unchanged,
      syncedAt,
    };
  } catch (error: any) {
    const debugError = debugErrorFromUnknown(error, stage);
    // eventMap/hashMap are mutated in place as each change succeeds, so saving
    // them here keeps the work already accepted by Google and stops the next
    // run from re-creating those events.
    await setSettings({
      googleCalendarEventMapJson: JSON.stringify(eventMap),
      googleCalendarEventHashMapJson: JSON.stringify(hashMap),
      googleCalendarLastSyncAt: nowIso(),
      googleCalendarLastSyncStatus: "failed",
      googleCalendarLastSyncError: debugError.message,
    });
    await noteGoogleApiFailure(accountId, debugError.httpStatus, debugError.googleReason).catch(() => undefined);
    await recordGoogleCalendarDebugEntry(
      finishEntry("failed", calendarId, status.accountEmail || "", {
        stage: debugError.stage,
        upserted,
        deleted,
        unchanged,
        retries: retryBudget.retries,
        request: error?.debugRequest || sampleRequest,
        requestIsSample: !error?.debugRequest && Boolean(sampleRequest),
        error: debugError,
      }),
      settings,
    );
    throw error;
  }
}

export function syncGoogleCalendarChangesIfEnabled(changes: GoogleCalendarChange[], trigger = "auto_sync") {
  const run = googleCalendarChangeQueue.then(() => syncGoogleCalendarChangesNow(changes, trigger));
  googleCalendarChangeQueue = run.catch(() => undefined);
  return run;
}

// Kept for compatibility. Automatic callers should pass explicit item changes;
// a no-argument call must never fall back to a full-calendar rebuild. Recorded
// in the debug log so a legacy caller shows up as a real (skipped) trigger
// instead of looking like the sync never fired.
export async function syncGoogleCalendarIfEnabled(trigger = "legacy_untargeted_call") {
  const status = await getGoogleCalendarSyncStatus();
  await recordGoogleCalendarDebugEntry(
    newDebugEntry({
      trigger,
      outcome: "skipped",
      reason: "targeted_change_required",
      stage: "preflight",
      calendarId: status.calendarId,
      accountEmail: status.accountEmail || "",
    }),
  );
  return { ...status, ok: true, skipped: true, reason: "targeted_change_required" };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default async function googleCalendarSyncHandler(req: Request) {
  try {
    if (req.method === "GET") {
      if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
      return json(await getGoogleCalendarSyncStatus(req));
    }
    if (req.method === "POST") {
      if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
      return json(await syncGoogleCalendarNow("api_google_calendar_sync_post"));
    }
    return json({ error: "method_not_allowed", message: "Use GET for status or POST to sync." }, 405);
  } catch (error: any) {
    console.error("google_calendar_sync:function_failed", error);
    return json(
      {
        error: "google_calendar_sync_error",
        message: error instanceof Error ? error.message : "Google Calendar sync failed.",
        failure: debugErrorFromUnknown(error, "sync"),
        request: error?.debugRequest || null,
      },
      error?.status || 500,
    );
  }
}

export const config: Config = {
  path: "/api/google-calendar-sync",
};
