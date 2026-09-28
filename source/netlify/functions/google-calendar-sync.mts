import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";
import {
  disconnectGoogleConnection,
  getGoogleAccessToken,
  googleCalendarScopes as googleScopes,
  hasGoogleScopes,
  listCoachCalendarConnections,
  loadGoogleProviderConnection,
  markConnectionHealthy,
  noteGoogleApiFailure,
  publicGoogleProviderStatus,
  saveGoogleAuthorization,
} from "./_shared/google-provider.mts";
import { unavailableSpans } from "./_shared/availability-blocks.mts";
import { primaryServiceLocationId } from "./_shared/service-scope.mts";
import { legacyOriginalWorkspaceId, slugify as cleanSlug } from "./_shared/account.mts";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import {
  availabilityForGoogleCoach,
  googleCoachesFromSettings,
  itemBelongsOnCoachCalendar,
  ownGoogleCoachId,
  type GoogleCoachProfile,
} from "./_shared/google-calendar-coach.mts";
import {
  SETTINGS_UPSERT_QUERY,
  settingsSelectQuery,
  settingsUpsertRows,
} from "./_shared/settings-scope.mts";
import { getClarityCloudGoogleConfig } from "./_shared/clarity-cloud-google-config.mts";
import {
  GOOGLE_IMPORT_ORIGIN,
  busyBlocksFromGoogleEvents,
  planBusyBlockImport,
  type GoogleCalendarSourceDisplay,
  type GoogleEvent,
} from "./_shared/google-calendar-import.mts";
import {
  calendarsToScan,
  findImportRuleForEvent,
  normalizeGoogleCalendarImportRules,
  ruleCoversCalendar,
  ruleIsUsable,
  type GoogleCalendarImportRule,
} from "./_shared/google-calendar-import-rules.mts";

const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
// Auto-sync every booking change to Google Calendar. Each booking mutation path
// (admin save/delete, single-item upsert, public booking + cancel) calls
// syncGoogleCalendarChangesIfEnabled(); with this false those calls actually
// run, gated only by each coach's googleCalendarAutoSync setting.
const googleCalendarManualSyncOnly = false;

// Deliberately empty.
//
// This used to hold the original coach's actual lesson list -- their names,
// their prices, "Bay hire included" -- as the fallback when a workspace had no
// servicesJson. Any other business syncing to Google would then have had that
// coach's lesson names written into their own calendar events. A workspace with
// no lesson types has no lesson types; the event falls back to a generic title.
const defaultServices: Array<Record<string, unknown>> = [];

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown, fallback = "", max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
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

function settingMap(rows: Array<{ key: string; value: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value || ""]));
}

// Every settings read and write here is scoped to one business. Google is a
// per-business connection -- the calendar id, the refresh token, the busy-block
// import rules -- and a global read would have handed a second coach the first
// coach's Google account, while a global upsert (on_conflict=key) no longer
// even matches the table's unique index.
async function readSettings(accountId: string) {
  return settingMap(await supabase("settings", { query: settingsSelectQuery(accountId) }));
}

async function setSetting(accountId: string, key: string, value: unknown) {
  await setSettings(accountId, { [key]: value });
}

async function setSettings(accountId: string, values: Record<string, unknown>) {
  const rows = settingsUpsertRows(accountId, values, nowIso());
  if (!rows.length) return;
  await supabase("settings", {
    method: "POST",
    query: SETTINGS_UPSERT_QUERY,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: rows,
  });
}

// ---------------------------------------------------------------------------
// Per-coach settings
//
// Each coach's calendar has its own chosen calendar, event maps, import rules
// and sync status, stored as "<key>:<coachId>". Everything else in settings is
// the business's (lesson types, locations, availability, the debug log).
// coachScopedSettings hands the sync a settings map where the plain key reads
// as that coach's value, so the code below reads settings.googleCalendarId and
// gets the right coach's calendar without spelling the suffix everywhere.
// ---------------------------------------------------------------------------

const COACH_SETTING_KEYS = [
  "googleCalendarId",
  "googleCalendarEventMapJson",
  "googleCalendarEventHashMapJson",
  "googleCalendarAutoSync",
  "googleCalendarImportRulesJson",
  "googleCalendarImportBusy",
  "googleCalendarLastSyncAt",
  "googleCalendarLastSyncStatus",
  "googleCalendarLastSyncError",
  "googleCalendarAccountEmail",
  "googleCalendarConnectedAt",
  "googleCalendarOAuthState",
  "googleCalendarOAuthStartedAt",
] as const;
const coachSettingKeySet = new Set<string>(COACH_SETTING_KEYS);

function coachSettingKey(key: string, coachId: string) {
  return `${key}:${coachId}`;
}

function coachScopedSettings(settings: Record<string, string>, coachId: string) {
  const scoped = { ...settings };
  for (const key of COACH_SETTING_KEYS) scoped[key] = settings[coachSettingKey(key, coachId)] || "";
  return scoped;
}

async function readCoachSettings(accountId: string, coachId: string) {
  return coachScopedSettings(await readSettings(accountId), coachId);
}

async function setCoachSettings(accountId: string, coachId: string, values: Record<string, unknown>) {
  await setSettings(
    accountId,
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [coachSettingKeySet.has(key) ? coachSettingKey(key, coachId) : key, value]),
    ),
  );
}

function coachesFromSettings(accountId: string, settings: Record<string, string>): GoogleCoachProfile[] {
  return googleCoachesFromSettings(accountId, settings.coachProfilesJson);
}

/**
 * Which coach's calendar a request is about, and whether the caller may touch
 * it. Anyone may manage their own; the owner and admins may manage any coach's
 * in their business, from that coach's profile. With no coach named it is the
 * caller's own.
 */
export async function resolveGoogleCalendarCoach(req: Request, requestedCoachId = "") {
  const actor = await requireCoachActor(req);
  const settings = await readSettings(actor.accountId);
  const coaches = coachesFromSettings(actor.accountId, settings);
  const ownCoachId = ownGoogleCoachId(actor, coaches, actor.accountId);
  const coachId = cleanString(requestedCoachId, "", 140) || ownCoachId;
  if (!coachId) {
    throw Object.assign(new Error("You do not have a coach profile to connect a calendar to."), { status: 409 });
  }
  if (coachId !== ownCoachId && !actor.isAdmin) {
    throw Object.assign(new Error("You can only manage your own calendar."), { status: 403 });
  }
  if (!coaches.some((coach) => coach.id === coachId)) {
    throw Object.assign(new Error("That coach is not in this business."), { status: 404 });
  }
  return { accountId: actor.accountId, coachId };
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function readGoogleCalendarImportRules(settings: Record<string, string>) {
  return normalizeGoogleCalendarImportRules(parseJson<unknown[]>(settings[googleCalendarImportRulesSettingKey], []));
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
const googleCalendarImportRulesSettingKey = "googleCalendarImportRulesJson";
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

/** A calendar on the connected Google account, offered as a scope for a rule. */
export type GoogleCalendarSource = {
  id: string;
  name: string;
  primary: boolean;
  hidden: boolean;
  accessRole: string;
};

export type GoogleCalendarDebugEntry = {
  id: string;
  /** Whose calendar the run was for. The log itself is the business's. */
  coachId: string;
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

async function readGoogleCalendarDebugEntries(accountId: string, settings?: Record<string, string>): Promise<GoogleCalendarDebugEntry[]> {
  const map = settings || (await readSettings(accountId));
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
    coachId: "",
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
  accountId: string,
  entry: Omit<GoogleCalendarDebugEntry, "id">,
  settings?: Record<string, string>,
) {
  try {
    if (!debugLoggingEnabled(settings)) return;
    const existing = await readGoogleCalendarDebugEntries(accountId);
    const next = trimDebugEntries([{ id: randomUUID(), ...entry }, ...existing]);
    await setSetting(accountId, debugLogSettingKey, JSON.stringify(next));
  } catch (error) {
    // The debug log must never be the reason a sync fails.
    console.error("google_calendar_sync:debug_log_write_failed", error);
  }
}

/** The runs for one coach's calendar. Entries written before calendars were per coach name none. */
export async function getGoogleCalendarDebugLog(accountId: string, coachId: string) {
  const settings = await readCoachSettings(accountId, coachId);
  const entries = await readGoogleCalendarDebugEntries(accountId, settings);
  return {
    ok: true,
    enabled: debugLoggingEnabled(settings),
    maxEntries: debugLogMaxEntries,
    autoSync: googleCalendarManualSyncOnly ? false : settings.googleCalendarAutoSync !== "false",
    manualOnly: googleCalendarManualSyncOnly,
    calendarId: settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"),
    entries: entries.filter((entry) => !entry.coachId || entry.coachId === coachId),
  };
}

export async function clearGoogleCalendarDebugLog(accountId: string, coachId: string) {
  await setSetting(accountId, debugLogSettingKey, "[]");
  return getGoogleCalendarDebugLog(accountId, coachId);
}

export async function setGoogleCalendarDebugEnabled(accountId: string, coachId: string, enabled: boolean) {
  await setSetting(accountId, debugEnabledSettingKey, enabled ? "true" : "false");
  return getGoogleCalendarDebugLog(accountId, coachId);
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
 * saving import rules — came back with an empty redirect URI and therefore
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

/** One coach's calendar connection. A business with no coach profile for the caller has no calendar. */
export async function getGoogleCalendarSyncStatus(accountId: string, coachId: string, req?: Request) {
  const settings = await readCoachSettings(accountId, coachId);
  const config = googleConfig(req);
  const configured = Boolean(config.clientId && config.clientSecret && config.redirectUri);
  // Never look up coach "": that is the business's Drive connection.
  const connection = coachId ? await loadGoogleProviderConnection(accountId, coachId) : null;
  const providerStatus = publicGoogleProviderStatus(connection, googleScopes);
  const connected = Boolean(
    connection?.calendarEnabled &&
      connection.connectionStatus === "connected" &&
      hasGoogleScopes(connection, googleScopes)
  );
  const calendarId = settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary");
  const importRules = readGoogleCalendarImportRules(settings);
  let sources: GoogleCalendarSource[] = [];
  let sourceListError = "";
  if (connected) {
    try {
      sources = await listGoogleCalendarSources(await getGoogleAccessToken(accountId, googleScopes, coachId));
    } catch (error) {
      sourceListError = error instanceof Error ? error.message.slice(0, 300) : "Google calendar sources could not be loaded.";
    }
  }
  return {
    configured,
    connected,
    accountId,
    coachId,
    calendarId,
    autoSync: googleCalendarManualSyncOnly ? false : settings.googleCalendarAutoSync !== "false",
    manualOnly: googleCalendarManualSyncOnly,
    accountEmail: providerStatus.accountEmail || settings.googleCalendarAccountEmail || "",
    lastSyncAt: settings.googleCalendarLastSyncAt || "",
    lastSyncStatus: settings.googleCalendarLastSyncStatus || "",
    lastSyncError: providerStatus.lastErrorCode || settings.googleCalendarLastSyncError || "",
    connectedAt: providerStatus.connectedAt || settings.googleCalendarConnectedAt || "",
    redirectUri: config.redirectUri,
    scope: googleScopes.join(" "),
    grantedScopes: providerStatus.grantedScopes,
    missingScopes: providerStatus.missingScopes,
    connectionStatus: providerStatus.connectionStatus,
    sources,
    sourceListError,
    importRules,
  };
}

export async function updateGoogleCalendarSyncSettings(accountId: string, coachId: string, body: any) {
  const values: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(body || {}, "calendarId")) {
    values.googleCalendarId = cleanCalendarId(body.calendarId);
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "autoSync")) {
    values.googleCalendarAutoSync = googleCalendarManualSyncOnly ? "false" : body.autoSync === false ? "false" : "true";
  } else if (googleCalendarManualSyncOnly) {
    values.googleCalendarAutoSync = "false";
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "importRules")) {
    values[googleCalendarImportRulesSettingKey] = JSON.stringify(
      normalizeGoogleCalendarImportRules(body.importRules),
    );
  }
  await setCoachSettings(accountId, coachId, values);
  return getGoogleCalendarSyncStatus(accountId, coachId);
}

export async function createGoogleCalendarAuthUrl(accountId: string, coachId: string, req: Request) {
  const config = googleConfig(req);
  if (!config.clientId || !config.clientSecret) {
    throw Object.assign(new Error("Google Calendar OAuth is not configured."), { status: 400 });
  }
  const state = randomUUID().replaceAll("-", "");
  await setCoachSettings(accountId, coachId, {
    googleCalendarOAuthState: state,
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

/**
 * Which business, and which coach in it, started this OAuth flow.
 *
 * The callback arrives from Google with no session, so both have to come out
 * of the flow itself. The state is a 128-bit random value this server wrote
 * into that coach's settings key when it built the authorize URL, so looking
 * the row up *by* the state is both the CSRF check and the resolution: an
 * attacker would have to guess the nonce to name a business or a coach, and a
 * browser cannot simply assert either.
 */
async function coachForOAuthState(state: string): Promise<{ accountId: string; coachId: string }> {
  const none = { accountId: "", coachId: "" };
  if (!state) return none;
  const prefix = coachSettingKey("googleCalendarOAuthState", "");
  const rows = await supabase("settings", {
    query: [
      "select=account_id,key",
      `key=like.${encodeURIComponent(prefix)}*`,
      `value=eq.${encodeURIComponent(state)}`,
      "limit=2",
    ].join("&"),
  });
  // Exactly one coach may hold a given nonce. Anything else is a collision or
  // tampering, and neither should pick a winner.
  if (rows.length !== 1) return none;
  const key = cleanString(rows[0]?.key, "", 300);
  return {
    accountId: cleanString(rows[0]?.account_id, "", 80),
    coachId: key.startsWith(prefix) ? key.slice(prefix.length) : "",
  };
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
  const { accountId, coachId } = await coachForOAuthState(state);
  if (!accountId || !coachId) {
    throw Object.assign(new Error("Google Calendar connection could not be verified."), { status: 400 });
  }
  const settings = await readCoachSettings(accountId, coachId);
  const expectedState = settings.googleCalendarOAuthState || "";
  if (!expectedState || state !== expectedState) {
    throw Object.assign(new Error("Google Calendar connection could not be verified."), { status: 400 });
  }
  const startedAt = Date.parse(settings.googleCalendarOAuthStartedAt || "");
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > 15 * 60 * 1000) {
    throw Object.assign(new Error("Google Calendar connection expired. Start again."), { status: 400 });
  }

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
    coachId,
    refreshToken: cleanString(token.refresh_token, "", 4000) || undefined,
    grantedScopes: cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean).length
      ? cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean)
      : googleScopes,
    // Google told us; anything else is a guess and must not overwrite the truth.
    scopesFromProvider: cleanString(token.scope, "", 3000).split(/\s+/).filter(Boolean).length > 0,
    providerEmail: email || settings.googleCalendarAccountEmail || "",
  });
  await setCoachSettings(accountId, coachId, {
    googleCalendarAccountEmail: email,
    googleCalendarConnectedAt: nowIso(),
    googleCalendarAutoSync: "true",
    googleCalendarOAuthState: "",
    googleCalendarOAuthStartedAt: "",
    googleCalendarLastSyncStatus: "connected",
    googleCalendarLastSyncError: "",
  });
  return getGoogleCalendarSyncStatus(accountId, coachId, req);
}

export async function disconnectGoogleCalendar(accountId: string, coachId: string, req?: Request) {
  await disconnectGoogleConnection(accountId, coachId);
  // Both maps go: a reconnect is a fresh start, and a hash left behind for an
  // event that no longer exists would make the next sync skip re-creating it.
  await setCoachSettings(accountId, coachId, {
    googleCalendarAccountEmail: "",
    googleCalendarConnectedAt: "",
    googleCalendarEventMapJson: "{}",
    googleCalendarEventHashMapJson: "{}",
    googleCalendarLastSyncStatus: "disconnected",
    googleCalendarLastSyncError: "",
  });
  return getGoogleCalendarSyncStatus(accountId, coachId, req);
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
  const byService = activeLocations.find((location) => location.id && location.id === primaryServiceLocationId(service));
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

/**
 * The business's own details, for the text written into Google Calendar events.
 *
 * The env fallbacks hold the ORIGINAL workspace's real business and venue, so
 * they only apply to that workspace. Any other business gets its own settings
 * or nothing -- otherwise a second coach's synced events would have been
 * titled "Sam Hale Golf" and located at "The Range 24/7 - Three Kings", written
 * into their personal Google Calendar.
 */
function accountFromSettings(accountId: string, settings: Record<string, string>) {
  const original = cleanSlug(accountId, "") === legacyOriginalWorkspaceId();
  const envIfOriginal = (name: string, legacy: string) => (original ? env(name, legacy) : "");
  return {
    businessName:
      settings.accountBusinessName || envIfOriginal("CLARITY_BUSINESS_NAME", "Sam Hale Golf") || "Clarity Golf",
    venueName: settings.accountVenueName || envIfOriginal("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName:
      settings.accountVenueShortName || envIfOriginal("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    // Timezone is formatting, not identity: every workspace needs one to render
    // an event at all, so the platform default applies to all of them.
    timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: settings.accountContactEmail || envIfOriginal("CLARITY_CONTACT_EMAIL", ""),
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

function googleEventForItem(accountId: string, item: any, settings: Record<string, string>, services: any[], locations: any[], eventId: string) {
  const account = accountFromSettings(accountId, settings);
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
 * Only events an import rule claims are pulled — see
 * `google-calendar-import-rules.mts`. With no rules defined nothing is
 * imported, which is deliberate: the coach's Google account holds plenty that
 * Clarity has no business mirroring, and silence is the safer default.
 *
 * What does come in becomes a block: no client, no lesson type, no price, and
 * `origin` set so the UI refuses to move or resize it and the outbound sync
 * refuses to send it back.
 *
 * Failure here must never fail the outbound sync. Pushing lessons to Google is
 * the job that matters; knowing about a Golf HQ commitment is the bonus. The
 * caller wraps this, and the outcome is reported either way rather than
 * swallowed — a silent import is how a broken sync hides for three days.
 */
async function importGoogleBusyBlocks(accountId: string, coachId: string, accessToken: string, settings: Record<string, string>) {
  const account = accountFromSettings(accountId, settings);
  const now = new Date();
  const timeMin = new Date(now.getTime() - busyImportWeeksBack * 7 * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + busyImportWeeksAhead * 7 * 86_400_000).toISOString();
  const importRules = readGoogleCalendarImportRules(settings);
  const usableRules = importRules.filter(ruleIsUsable);
  const sources = await listGoogleCalendarSources(accessToken);
  const scanIds = calendarsToScan(usableRules, sources.map((source) => source.id));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  let scanned = 0;
  let matched = 0;
  let truncated = false;
  const wanted: ReturnType<typeof busyBlocksFromGoogleEvents> = [];

  // Each calendar is fetched once and then offered to every rule that reads it.
  // Fetching per rule would pull the same calendar twice the moment two rules
  // share a scope, and the second copy is identical.
  for (const calendarSourceId of scanIds) {
    const rulesHere = usableRules.filter((rule) => ruleCoversCalendar(rule, calendarSourceId));
    if (!rulesHere.length) continue;
    const { events, truncated: sourceTruncated } = await listGoogleEvents(accessToken, calendarSourceId, timeMin, timeMax);
    scanned += events.length;
    truncated ||= sourceTruncated;

    // Group by the rule that claimed the event. An event belongs to exactly one
    // rule, so it can never produce two blocks fighting over the same row id.
    const byRule = new Map<string, { rule: GoogleCalendarImportRule; events: GoogleEvent[] }>();
    for (const event of events) {
      const rule = findImportRuleForEvent(event, rulesHere);
      if (!rule) continue;
      matched += 1;
      const bucket = byRule.get(rule.id) || { rule, events: [] };
      bucket.events.push(event);
      byRule.set(rule.id, bucket);
    }

    for (const { rule, events: ruleEvents } of byRule.values()) {
      wanted.push(
        ...busyBlocksFromGoogleEvents(ruleEvents, account.timezone, {
          // The calendar keys the row id, so a block keeps its identity when the
          // coach renames a rule or retypes an alias.
          sourceId: calendarSourceId,
          sourceName: rule.name || sourceById.get(calendarSourceId)?.name || "",
          showLabel: rule.showLabel,
        } satisfies GoogleCalendarSourceDisplay).map((block) => ({
          ...block,
          // And the coach, because two coaches can both read a shared calendar
          // (the academy's own), and each needs their own copy of that busy
          // time -- one row would be claimed back and forth between them.
          id: `${block.id}-${cleanSlug(coachId, "coach")}`,
        })),
      );
    }
  }

  // Only rows this import owns are ever read here, and therefore only they can
  // ever be deleted below. A lesson or a coach's own block is out of reach --
  // and so is another business's Google import, which the origin filter alone
  // did not exclude, and another coach's, which the account filter did not.
  const existingRows = (await supabase("calendar_items", {
    query:
      `select=id,week,day,start,duration,title,external_source` +
      `&origin=eq.${encodeURIComponent(GOOGLE_IMPORT_ORIGIN)}` +
      `&account_id=eq.${encodeURIComponent(accountId)}` +
      `&coach_id=eq.${encodeURIComponent(coachId)}`,
  })) as Array<Record<string, unknown>>;
  const plan = planBusyBlockImport(wanted, existingRows.map((row) => ({ ...row, id: String(row.id) })));

  // The coach owns their own diary, so the block files under the business and
  // the coach this import is running for -- not a slug read back out of
  // settings.
  const rowFor = (block: (typeof wanted)[number]) => ({
    id: block.id,
    account_id: accountId,
    kind: "block",
    title: block.title,
    client: "",
    week: block.week,
    day: block.day,
    start: block.start,
    duration: block.duration,
    status: "booked",
    coach_id: coachId,
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
      // Account- and coach-scoped as well as origin-scoped: an id list on its
      // own would let one import delete another's blocks.
      query:
        `origin=eq.${encodeURIComponent(GOOGLE_IMPORT_ORIGIN)}` +
        `&account_id=eq.${encodeURIComponent(accountId)}` +
        `&coach_id=eq.${encodeURIComponent(coachId)}` +
        `&id=in.(${encodeURIComponent(list)})`,
    });
  }
  return {
    scanned,
    matched,
    imported: plan.create.length,
    updated: plan.update.length,
    removed: plan.deleteIds.length,
    unchanged: plan.unchanged,
    truncated,
    calendarsScanned: scanIds.length,
    rules: usableRules.map((rule) => ({ id: rule.id, name: rule.name })),
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
function unavailableSyncItems(settings: Record<string, string>, coachId: string, coaches: GoogleCoachProfile[]) {
  // This coach's hours only. Across coaches, the business is closed only when
  // nobody works; one coach's calendar is closed whenever they do not.
  const availability = availabilityForGoogleCoach(parseJson<any[][]>(settings.availabilityJson, []), coachId, coaches);
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

async function calendarSyncPayload(accountId: string, coachId: string) {
  const [settingsRows, itemRows] = await Promise.all([
    supabase("settings", { query: settingsSelectQuery(accountId) }),
    supabase("calendar_items", {
      // Scoped. Unfiltered, a coach pressing "Sync now" pushed every other
      // business's bookings into their own Google Calendar.
      query: `select=*&account_id=eq.${encodeURIComponent(accountId)}&order=week.asc,day.asc,start.asc,id.asc`,
    }),
  ]);
  const settings = coachScopedSettings(settingMap(settingsRows), coachId);
  const services = parseJson<any[]>(settings.servicesJson, defaultServices);
  const coaches = coachesFromSettings(accountId, settings);
  return {
    settings,
    items: [
      ...itemRows
        .map(rowToItem)
        .filter((item) => isBusyGoogleItem(item) && itemBelongsOnCoachCalendar(item, coachId, services, coaches)),
      ...unavailableSyncItems(settings, coachId, coaches),
    ],
    services,
    locations: parseJson(settings.locationsJson, []),
  };
}

/** A full rebuild of one coach's Google Calendar from Clarity. */
export async function syncGoogleCalendarNow(accountId: string, coachId: string, trigger = "manual_sync_now") {
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const { settings, items, services, locations } = await calendarSyncPayload(accountId, coachId);
  const status = await getGoogleCalendarSyncStatus(accountId, coachId);
  const calendarId = cleanCalendarId(settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"));

  const finishEntry = (outcome: GoogleCalendarDebugEntry["outcome"], detail: Partial<Omit<GoogleCalendarDebugEntry, "id">> = {}) =>
    newDebugEntry({
      coachId,
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
    await recordGoogleCalendarDebugEntry(accountId, finishEntry("skipped", { reason, stage: "preflight" }), settings);
    return { ...status, ok: false, skipped: true, reason };
  };
  if (!status.configured) return skip("google_oauth_not_configured");
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

  // Partial progress has to survive a mid-run failure. Without this, events
  // already created in Google are absent from the stored map, so the next run
  // POSTs them again, takes a 409, and recovers with a PUT -- two requests per
  // item instead of none, which makes each retry hit the rate limit sooner
  // than the last.
  const persistProgress = async (extra: Record<string, unknown>) =>
    setCoachSettings(accountId, coachId, {
      googleCalendarId: calendarId,
      googleCalendarEventMapJson: JSON.stringify({ ...previousMap, ...nextMap }),
      googleCalendarEventHashMapJson: JSON.stringify({ ...previousHashMap, ...nextHashMap }),
      ...extra,
    });

  try {
    const accessToken = await getGoogleAccessToken(accountId, googleScopes, coachId);

    stage = "upsert";
    for (const item of items) {
      const eventId = previousMap[item.id] || googleEventId(item.id);
      const event = googleEventForItem(accountId, item, settings, services, locations, eventId);
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
    await setCoachSettings(accountId, coachId, {
      googleCalendarId: calendarId,
      googleCalendarEventMapJson: JSON.stringify(nextMap),
      googleCalendarEventHashMapJson: JSON.stringify(nextHashMap),
      googleCalendarLastSyncAt: syncedAt,
      googleCalendarLastSyncStatus: "synced",
      googleCalendarLastSyncError: "",
    });
    // Work actually landed in Google, so the connection has earned "connected"
    // — the only place that claim is made. A token refresh no longer makes it.
    await markConnectionHealthy(accountId, coachId).catch(() => undefined);

    // Then the other direction: the coach's other commitments come back as
    // read-only busy blocks. Deliberately after the push and deliberately
    // isolated — getting lessons into Google is the job, and a failure to read
    // Golf HQ's diary must not report the whole sync as broken. The outcome is
    // returned either way rather than swallowed.
    let busyImport: Record<string, unknown> | null = null;
    let busyImportError = "";
    if (settings.googleCalendarImportBusy !== "false") {
      try {
        busyImport = await importGoogleBusyBlocks(accountId, coachId, accessToken, settings);
      } catch (error: any) {
        busyImportError = error instanceof Error ? error.message.slice(0, 300) : "Busy import failed.";
        // The import failing is isolated from the push, but it must not be
        // silent. It was: a check constraint rejected every imported row and
        // the only record of it was a string returned to a caller that ignored
        // it, so the import produced nothing for months while every sync
        // reported success. The debug window is where a broken sync is meant to
        // become visible, so this gets its own failed entry.
        await recordGoogleCalendarDebugEntry(
      accountId,
          finishEntry("failed", {
            stage: "busy_import",
            reason: busyImportError,
            error: debugErrorFromUnknown(error, "busy_import"),
          }),
          settings,
        );
      }
    }
    await recordGoogleCalendarDebugEntry(
      accountId,
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
      ...(await getGoogleCalendarSyncStatus(accountId, coachId)),
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
    await noteGoogleApiFailure(accountId, debugError.httpStatus, debugError.googleReason, coachId).catch(() => undefined);
    await recordGoogleCalendarDebugEntry(
      accountId,
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

/**
 * Push a handful of changed items to every connected coach calendar they
 * touch. Each item is sent to the calendar of the coach it now belongs to, and
 * taken off any other coach's calendar that still holds it -- a lesson handed
 * from one coach to another has to leave the first diary as well as arrive in
 * the second.
 */
async function syncGoogleCalendarChangesNow(accountId: string, changes: GoogleCalendarChange[], trigger = "auto_sync") {
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
  if (!normalized.length) return { ok: true, skipped: true, reason: "no_google_relevant_changes", coaches: [] };

  const connections = await listCoachCalendarConnections(accountId);
  if (!connections.length) return { ok: true, skipped: true, reason: "google_calendar_not_connected", coaches: [] };

  const accountSettings = await readSettings(accountId);
  const services = parseJson<any[]>(accountSettings.servicesJson, defaultServices);
  const coaches = coachesFromSettings(accountId, accountSettings);
  const upsertIds = normalized.filter((change) => change.action !== "delete").map((change) => change.id);
  const itemsById = new Map<string, any>();
  if (upsertIds.length) {
    const rows = await supabase("calendar_items", {
      // Scoped by account as well as id: this decides what gets pushed to (or
      // deleted from) this business's coaches' calendars.
      query:
        `select=*&id=in.(${encodeURIComponent(upsertIds.map((id) => `"${id}"`).join(","))})` +
        `&account_id=eq.${encodeURIComponent(accountId)}`,
    });
    for (const row of rows) itemsById.set(String(row.id), rowToItem(row));
  }

  const results = [];
  for (const connection of connections) {
    // One coach's failure must not stop the others' calendars being updated.
    try {
      results.push(
        await syncCoachCalendarChangesNow(accountId, connection.coachId, normalized, itemsById, services, coaches, trigger),
      );
    } catch (error) {
      results.push({ ok: false, coachId: connection.coachId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: results.every((result) => result.ok !== false), skipped: false, coaches: results };
}

async function syncCoachCalendarChangesNow(
  accountId: string,
  coachId: string,
  normalized: Array<{ id: string; action: "upsert" | "delete" }>,
  itemsById: Map<string, any>,
  services: any[],
  coaches: GoogleCoachProfile[],
  trigger: string,
) {
  const startedAtMs = Date.now();
  const startedAt = nowIso();
  const finishEntry = (
    outcome: GoogleCalendarDebugEntry["outcome"],
    calendarId: string,
    accountEmail: string,
    detail: Partial<Omit<GoogleCalendarDebugEntry, "id">> = {},
  ) =>
    newDebugEntry({
      coachId,
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

  const settings = await readCoachSettings(accountId, coachId);
  const calendarId = cleanCalendarId(settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"));
  const eventMap = parseJson<Record<string, string>>(settings.googleCalendarEventMapJson, {});
  const hashMap = parseJson<Record<string, string>>(settings.googleCalendarEventHashMapJson, {});

  // What this coach's calendar has to do: send what is theirs, and take down
  // what it holds that no longer is. Everything else is another coach's
  // business, and not even worth a request.
  const work = normalized.flatMap((change) => {
    const item = itemsById.get(change.id) || null;
    const ours = Boolean(item) && itemBelongsOnCoachCalendar(item, coachId, services, coaches);
    if (change.action !== "delete" && ours && isBusyGoogleItem(item)) return [{ id: change.id, item }];
    return eventMap[change.id] || ours ? [{ id: change.id, item: null }] : [];
  });
  if (!work.length) return { ok: true, coachId, skipped: true, reason: "not_on_this_calendar" };

  const skip = async (reason: string, ok: boolean) => {
    const status = await getGoogleCalendarSyncStatus(accountId, coachId);
    await recordGoogleCalendarDebugEntry(
      accountId,
      finishEntry("skipped", calendarId, status.accountEmail || "", { reason, stage: "preflight" }),
      settings,
    );
    return { ok, coachId, skipped: true, reason };
  };
  if (settings.googleCalendarAutoSync === "false") return skip("auto_sync_disabled", true);
  const status = await getGoogleCalendarSyncStatus(accountId, coachId);
  if (!status.configured) return skip("google_oauth_not_configured", false);
  if (!status.connected) return skip("google_calendar_not_connected", false);

  const locations = parseJson(settings.locationsJson, []);
  let sampleRequest: GoogleCalendarDebugRequest | null = null;
  let upserted = 0;
  let deleted = 0;
  let unchanged = 0;
  let stage = "access_token";
  const retryBudget: GoogleRetryBudget = { spentMs: 0, retries: 0 };

  try {
    const accessToken = await getGoogleAccessToken(accountId, googleScopes, coachId);

    stage = "changes";
    for (const { id, item } of work) {
      if (!item) {
        const eventId = eventMap[id] || googleEventId(id);
        stage = "delete";
        if (await deleteGoogleEvent(accessToken, calendarId, eventId, id, retryBudget)) deleted += 1;
        delete eventMap[id];
        delete hashMap[id];
        continue;
      }

      const eventId = eventMap[item.id] || googleEventId(item.id);
      const event = googleEventForItem(accountId, item, settings, services, locations, eventId);
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
    await setCoachSettings(accountId, coachId, {
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
    if (!noWork) await markConnectionHealthy(accountId, coachId).catch(() => undefined);
    await recordGoogleCalendarDebugEntry(
      accountId,
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
    return { ok: true, coachId, skipped: noWork, reason: noWork ? "unchanged" : undefined, upserted, deleted, unchanged, syncedAt };
  } catch (error: any) {
    const debugError = debugErrorFromUnknown(error, stage);
    // eventMap/hashMap are mutated in place as each change succeeds, so saving
    // them here keeps the work already accepted by Google and stops the next
    // run from re-creating those events.
    await setCoachSettings(accountId, coachId, {
      googleCalendarEventMapJson: JSON.stringify(eventMap),
      googleCalendarEventHashMapJson: JSON.stringify(hashMap),
      googleCalendarLastSyncAt: nowIso(),
      googleCalendarLastSyncStatus: "failed",
      googleCalendarLastSyncError: debugError.message,
    });
    await noteGoogleApiFailure(accountId, debugError.httpStatus, debugError.googleReason, coachId).catch(() => undefined);
    await recordGoogleCalendarDebugEntry(
      accountId,
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

export function syncGoogleCalendarChangesIfEnabled(accountId: string, changes: GoogleCalendarChange[], trigger = "auto_sync") {
  const run = googleCalendarChangeQueue.then(() => syncGoogleCalendarChangesNow(accountId, changes, trigger));
  googleCalendarChangeQueue = run.catch(() => undefined);
  return run;
}

/**
 * A full rebuild of every connected coach calendar -- in one business, or in
 * every business when no account is given (the nightly reconcile). Coaches run
 * one after another, and one coach's failure is reported without stopping the
 * rest.
 */
export async function syncAllCoachCalendarsNow(accountId: string, trigger: string) {
  const connections = await listCoachCalendarConnections(accountId);
  const results = [];
  for (const connection of connections) {
    try {
      const result = await syncGoogleCalendarNow(connection.accountId, connection.coachId, trigger);
      results.push({
        accountId: connection.accountId,
        coachId: connection.coachId,
        ok: result.ok !== false,
        reason: "reason" in result ? String(result.reason || "") : "",
      });
    } catch (error) {
      results.push({
        accountId: connection.accountId,
        coachId: connection.coachId,
        ok: false,
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
  }
  return { ok: results.every((result) => result.ok), calendars: results };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default async function googleCalendarSyncHandler(req: Request) {
  try {
    if (req.method === "GET" || req.method === "POST") {
      // A coach calendar belongs to one coach in one business, so the route
      // needs both, and the caller has to be allowed that coach.
      const { accountId, coachId } = await resolveGoogleCalendarCoach(req, new URL(req.url).searchParams.get("coachId") || "");
      if (req.method === "GET") return json(await getGoogleCalendarSyncStatus(accountId, coachId, req));
      return json(await syncGoogleCalendarNow(accountId, coachId, "api_google_calendar_sync_post"));
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
