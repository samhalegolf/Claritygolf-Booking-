import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";

const sessionCookieName = "clarity_session";
const baseWeekStart = new Date(Date.UTC(2026, 5, 1));
const googleCalendarSyncInFlightTtlMs = 60_000;
const googleCalendarRateLimitCooldownMs = 60_000;
const googleScopes = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

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

function toIsoDate(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function timestampMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isActiveTimestamp(value: string) {
  const parsed = timestampMs(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function parseRetryAfterHeaderValue(value: string | null, now = Date.now()) {
  if (!value) return toIsoDate(new Date(now + googleCalendarRateLimitCooldownMs).toISOString());
  const trimmed = value.trim();
  if (!trimmed) return toIsoDate(new Date(now + googleCalendarRateLimitCooldownMs).toISOString());
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return toIsoDate(new Date(now + seconds * 1000).toISOString());
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return toIsoDate(new Date(parsed).toISOString());
  return toIsoDate(new Date(now + googleCalendarRateLimitCooldownMs).toISOString());
}

function stableText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.slice(0, 200) : fallback;
}

function normaliseCalendarSyncLocationSnapshot(raw: any) {
  const value = cleanBookingLocationSnapshot(raw, {});
  return value
    ? {
        locationId: stableText(value.locationId, ""),
        name: stableText(value.name, ""),
        shortName: stableText(value.shortName, value.name || ""),
        address: stableText(value.address, ""),
        mapUrl: stableText(value.mapUrl, ""),
        arrivalInstructions: stableText(value.arrivalInstructions, ""),
        publicNotes: stableText(value.publicNotes, ""),
        timezone: stableText(value.timezone, ""),
      }
    : null;
}

function normaliseCalendarSyncItem(item: ReturnType<typeof rowToItem>) {
  return {
    id: stableText(item.id),
    kind: item.kind === "block" ? "block" : "appointment",
    week: Number(item.week ?? 0),
    day: Number(item.day ?? 0),
    start: Number(item.start ?? 0),
    duration: Number(item.duration ?? 0),
    serviceId: stableText(item.serviceId, ""),
    coachId: stableText(item.coachId, ""),
    client: stableText(item.client, ""),
    title: stableText(item.title, ""),
    phone: stableText(item.phone, ""),
    email: stableText(item.email, ""),
    note: stableText(item.note, ""),
    location: normaliseCalendarSyncLocationSnapshot(item.location),
    coach: item.coach ? {
      id: stableText(item.coach.id, ""),
      name: stableText(item.coach.name, ""),
    } : null,
  };
}

function normaliseCalendarSyncPayload(value: unknown, fallback = "") {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .slice(0, 180)
    : fallback;
}

function normaliseCalendarSyncLocation(location: any, fallback: any = {}) {
  return {
    id: normaliseCalendarSyncPayload(location?.id),
    name: normaliseCalendarSyncPayload(location?.name),
    shortName: normaliseCalendarSyncPayload(location?.shortName),
    address: normaliseCalendarSyncPayload(location?.address),
    timezone: normaliseCalendarSyncPayload(location?.timezone),
    isDefault: location?.isDefault === true,
    archived: location?.archived === true,
    active: location?.active !== false,
  };
}

function normaliseCalendarSyncService(service: any, fallback: any = {}) {
  return {
    id: normaliseCalendarSyncPayload(service?.id, fallback.id || ""),
    name: normaliseCalendarSyncPayload(service?.name, fallback.name || ""),
    locationId: normaliseCalendarSyncPayload(service?.locationId),
    lessonNote: normaliseCalendarSyncPayload(service?.lessonNote, fallback.lessonNote || ""),
    location: normaliseCalendarSyncPayload(service?.location, fallback.location || ""),
    duration: Number(service?.duration ?? fallback.duration ?? 0),
    price: Number(service?.price ?? fallback.price ?? 0),
    active: service?.archived === true ? false : service?.active !== false,
    archived: service?.archived === true,
  };
}

function stableGoogleCalendarSyncPayloadHash(
  settings: Record<string, string>,
  items: ReturnType<typeof rowToItem>[],
  services: any[],
  locations: any[],
  calendarId: string,
) {
  const account = {
    businessName: settings.accountBusinessName || env("CLARITY_BUSINESS_NAME", "Sam Hale Golf"),
    venueName: settings.accountVenueName || env("CLARITY_VENUE_NAME", "The Range 24/7 - Three Kings"),
    venueShortName: settings.accountVenueShortName || env("CLARITY_VENUE_SHORT_NAME", "The Range 24/7"),
    timezone: settings.accountTimezone || env("CLARITY_TIMEZONE", "Pacific/Auckland"),
    contactEmail: settings.accountContactEmail || env("CLARITY_CONTACT_EMAIL", ""),
  };
  const payload = {
    calendarId,
    account: {
      businessName: account.businessName,
      venueName: account.venueName,
      venueShortName: account.venueShortName,
      timezone: account.timezone,
      contactEmail: account.contactEmail,
    },
    services: (Array.isArray(services) ? services : [])
      .map((service, index) => normaliseCalendarSyncService(service, defaultServices[index]))
      .sort((first, second) => first.id.localeCompare(second.id)),
    locations: (Array.isArray(locations) ? locations : [])
      .map((location) => normaliseCalendarSyncLocation(location))
      .sort((first, second) => first.id.localeCompare(second.id)),
    items: items
      .map(normaliseCalendarSyncItem)
      .sort((first, second) => first.id.localeCompare(second.id)),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function acquireGoogleCalendarSyncLock() {
  const settings = await readSettings();
  if (isActiveTimestamp(settings.googleCalendarSyncInFlightUntil || "")) {
    return {
      ok: false,
      reason: "in_flight" as const,
      inFlightUntil: settings.googleCalendarSyncInFlightUntil || "",
    };
  }

  const token = randomUUID();
  const expires = new Date(Date.now() + googleCalendarSyncInFlightTtlMs).toISOString();
  await setSettings({
    googleCalendarSyncInFlightToken: token,
    googleCalendarSyncInFlightUntil: expires,
  });
  const verified = await readSettings();
  if (verified.googleCalendarSyncInFlightToken !== token || !isActiveTimestamp(verified.googleCalendarSyncInFlightUntil || "")) {
    return {
      ok: false,
      reason: "in_flight" as const,
      inFlightUntil: verified.googleCalendarSyncInFlightUntil || expires,
    };
  }
  return { ok: true, token, inFlightUntil: expires };
}

async function releaseGoogleCalendarSyncLock(token: string) {
  const settings = await readSettings();
  if (!token || settings.googleCalendarSyncInFlightToken !== token) return;
  await setSettings({
    googleCalendarSyncInFlightUntil: "",
    googleCalendarSyncInFlightToken: "",
  });
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

function configuredRedirectUri(req: Request) {
  const configured = env("GOOGLE_CALENDAR_REDIRECT_URI", "");
  if (configured) return configured;
  const url = new URL(req.url);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLocalHost) return "https://claritygolf.app/api/google-calendar/callback";
  return `${url.origin}/api/google-calendar/callback`;
}

function googleConfig(req?: Request) {
  return {
    clientId: env("GOOGLE_CALENDAR_CLIENT_ID", ""),
    clientSecret: env("GOOGLE_CALENDAR_CLIENT_SECRET", ""),
    redirectUri: req ? configuredRedirectUri(req) : env("GOOGLE_CALENDAR_REDIRECT_URI", ""),
  };
}

function cleanCalendarId(value: unknown) {
  return cleanString(value, "primary", 320) || "primary";
}

export async function getGoogleCalendarSyncStatus(req?: Request) {
  const settings = await readSettings();
  const config = googleConfig(req);
  const configured = Boolean(config.clientId && config.clientSecret && (config.redirectUri || req));
  const connected = Boolean(settings.googleCalendarRefreshToken);
  return {
    configured,
    connected,
    calendarId: settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"),
    autoSync: settings.googleCalendarAutoSync !== "false",
    accountEmail: settings.googleCalendarAccountEmail || "",
    lastSyncAt: settings.googleCalendarLastSyncAt || "",
    lastSyncStatus: settings.googleCalendarLastSyncStatus || "",
    lastSyncError: settings.googleCalendarLastSyncError || "",
    connectedAt: settings.googleCalendarConnectedAt || "",
    cooldownUntil: settings.googleCalendarCooldownUntil || "",
    inFlightUntil: settings.googleCalendarSyncInFlightUntil || "",
    redirectUri: req ? configuredRedirectUri(req) : config.redirectUri,
    scope: googleScopes.join(" "),
  };
}

export async function updateGoogleCalendarSyncSettings(body: any) {
  const values: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(body || {}, "calendarId")) {
    values.googleCalendarId = cleanCalendarId(body.calendarId);
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, "autoSync")) {
    values.googleCalendarAutoSync = body.autoSync === false ? "false" : "true";
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
  await setSettings({
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

async function accessTokenFromRefreshToken(refreshToken: string) {
  const config = googleConfig();
  const data = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return data.access_token as string;
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

  const config = googleConfig(req);
  const token = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
    grant_type: "authorization_code",
  });
  const refreshToken = cleanString(token.refresh_token, settings.googleCalendarRefreshToken || "", 4000);
  if (!refreshToken) {
    throw Object.assign(new Error("Google did not return an offline refresh token. Try connecting again."), { status: 400 });
  }
  const email = token.access_token ? await userEmail(token.access_token) : "";
  await setSettings({
    googleCalendarRefreshToken: refreshToken,
    googleCalendarAccountEmail: email,
    googleCalendarConnectedAt: nowIso(),
    googleCalendarAutoSync: "true",
    googleCalendarOAuthState: "",
    googleCalendarOAuthStartedAt: "",
    googleCalendarLastSyncStatus: "connected",
    googleCalendarLastSyncError: "",
    googleCalendarCooldownUntil: "",
    googleCalendarSyncInFlightUntil: "",
    googleCalendarSyncInFlightToken: "",
  });
  return getGoogleCalendarSyncStatus(req);
}

export async function disconnectGoogleCalendar(req?: Request) {
  await setSettings({
    googleCalendarRefreshToken: "",
    googleCalendarAccountEmail: "",
    googleCalendarConnectedAt: "",
    googleCalendarEventMapJson: "{}",
    googleCalendarLastSyncStatus: "disconnected",
    googleCalendarLastSyncError: "",
    googleCalendarCooldownUntil: "",
    googleCalendarSyncInFlightUntil: "",
    googleCalendarSyncInFlightToken: "",
    googleCalendarLastSyncPayloadHash: "",
  });
  return getGoogleCalendarSyncStatus(req);
}

function rowToItem(row: any) {
  return {
    id: row.id,
    kind: row.kind === "block" ? "block" : "appointment",
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
  if (item.kind === "block") return `Busy - ${account.businessName}`;
  return `${item.client || item.title} - ${serviceName(item.serviceId, services)}`;
}

function eventDescription(item: any, services: any[], location: any) {
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
  const start = googleLocalDateTime(week, item.day, item.start);
  const end = googleLocalDateTime(week, item.day, item.start + item.duration);
  return {
    id: eventId,
    summary: eventSummary(item, account, services),
    description: eventDescription(item, services, location),
    location: bookingLocationDisplay(location),
    start: { dateTime: start, timeZone: timezone },
    end: { dateTime: end, timeZone: timezone },
    transparency: "opaque",
    visibility: item.kind === "block" ? "private" : "default",
    extendedProperties: {
      private: {
        clarityBooking: "true",
        clarityBookingId: item.id,
        clarityKind: item.kind,
      },
    },
  };
}

async function googleCalendarRequest(accessToken: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const retryAfter = parseRetryAfterHeaderValue(response.headers.get("Retry-After"));
    throw Object.assign(new Error(data.error?.message || data.error || `Google Calendar request failed ${response.status}`), {
      status: response.status,
      googleError: data,
      googleRetryAfter: retryAfter,
    });
  }
  return data;
}

async function upsertGoogleEvent(accessToken: string, calendarId: string, eventId: string, event: any) {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);
  try {
    return await googleCalendarRequest(
      accessToken,
      `/calendars/${encodedCalendarId}/events/${encodedEventId}?sendUpdates=none`,
      { method: "PUT", body: JSON.stringify(event) },
    );
  } catch (error: any) {
    if (error?.status !== 404) throw error;
    return googleCalendarRequest(accessToken, `/calendars/${encodedCalendarId}/events?sendUpdates=none`, {
      method: "POST",
      body: JSON.stringify(event),
    });
  }
}

async function deleteGoogleEvent(accessToken: string, calendarId: string, eventId: string) {
  const encodedCalendarId = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);
  try {
    await googleCalendarRequest(accessToken, `/calendars/${encodedCalendarId}/events/${encodedEventId}?sendUpdates=none`, {
      method: "DELETE",
    });
    return true;
  } catch (error: any) {
    if (error?.status === 404 || error?.status === 410) return false;
    throw error;
  }
}

async function calendarSyncPayload() {
  const [settingsRows, itemRows] = await Promise.all([
    supabase("settings", { query: "select=key,value" }),
    supabase("calendar_items", { query: "select=*&order=week.asc,day.asc,start.asc,id.asc" }),
  ]);
  const settings = settingMap(settingsRows);
  return {
    settings,
    items: itemRows.map(rowToItem).filter((item) => !isCancelledGroupSessionItem(item)),
    services: parseJson(settings.servicesJson, defaultServices),
    locations: parseJson(settings.locationsJson, []),
  };
}

export async function syncGoogleCalendarNow() {
  const { settings, items, services, locations } = await calendarSyncPayload();
  const status = await getGoogleCalendarSyncStatus();
  if (!status.configured) return { ...status, ok: false, skipped: true, reason: "google_oauth_not_configured" };
  if (!settings.googleCalendarRefreshToken) return { ...status, ok: false, skipped: true, reason: "google_calendar_not_connected" };
  if (isActiveTimestamp(settings.googleCalendarCooldownUntil || "")) {
    return {
      ...status,
      ok: true,
      skipped: true,
      reason: "cooldown",
      cooldownUntil: settings.googleCalendarCooldownUntil,
    };
  }

  const lock = await acquireGoogleCalendarSyncLock();
  if (!lock.ok) {
    return {
      ...status,
      ok: true,
      skipped: true,
      reason: lock.reason,
      inFlightUntil: lock.inFlightUntil,
    };
  }
  const lockToken = lock.token;

  const calendarId = cleanCalendarId(settings.googleCalendarId || env("GOOGLE_CALENDAR_ID", "primary"));
  const previousMap = parseJson<Record<string, string>>(settings.googleCalendarEventMapJson, {});
  const nextMap: Record<string, string> = {};
  const payloadHash = stableGoogleCalendarSyncPayloadHash(settings, items, services, locations, calendarId);
  const previousPayloadHash = settings.googleCalendarLastSyncPayloadHash || "";
  const payloadSameAsLast = Boolean(previousPayloadHash && previousPayloadHash === payloadHash);
  let upserted = 0;
  let deleted = 0;

  try {
    const accessToken = await accessTokenFromRefreshToken(settings.googleCalendarRefreshToken);
    if (payloadSameAsLast) {
      const syncedAt = nowIso();
      await setSettings({
        googleCalendarId: calendarId,
        googleCalendarLastSyncAt: syncedAt,
        googleCalendarLastSyncStatus: "unchanged",
        googleCalendarLastSyncError: "",
        googleCalendarLastSyncPayloadHash: payloadHash,
        googleCalendarCooldownUntil: "",
      });
      return {
        ...(await getGoogleCalendarSyncStatus()),
        ok: true,
        skipped: true,
        reason: "unchanged",
        upserted: 0,
        deleted: 0,
        syncedAt,
      };
    }

    for (const item of items) {
      const eventId = previousMap[item.id] || googleEventId(item.id);
      const event = googleEventForItem(item, settings, services, locations, eventId);
      const result = await upsertGoogleEvent(accessToken, calendarId, eventId, event);
      nextMap[item.id] = result.id || eventId;
      upserted += 1;
    }

    for (const [itemId, eventId] of Object.entries(previousMap)) {
      if (nextMap[itemId]) continue;
      if (await deleteGoogleEvent(accessToken, calendarId, eventId)) deleted += 1;
    }

    const syncedAt = nowIso();
    await setSettings({
      googleCalendarId: calendarId,
      googleCalendarEventMapJson: JSON.stringify(nextMap),
      googleCalendarLastSyncAt: syncedAt,
      googleCalendarLastSyncStatus: "synced",
      googleCalendarLastSyncError: "",
      googleCalendarLastSyncPayloadHash: payloadHash,
      googleCalendarCooldownUntil: "",
    });
    return {
      ...(await getGoogleCalendarSyncStatus()),
      ok: true,
      skipped: false,
      upserted,
      deleted,
      syncedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Calendar sync failed.";

    const googleError = error as Error & { status?: number; googleRetryAfter?: string };
    if (googleError?.status === 429) {
      const retryAfter = googleError.googleRetryAfter || parseRetryAfterHeaderValue(null, Date.now());
      await setSettings({
        googleCalendarLastSyncAt: nowIso(),
        googleCalendarLastSyncStatus: "rate_limited",
        googleCalendarLastSyncError: "Rate limit reached. Direct sync will retry after cooldown.",
        googleCalendarCooldownUntil: retryAfter,
      });
      return {
        ...(await getGoogleCalendarSyncStatus()),
        ok: true,
        skipped: true,
        reason: "rate_limited",
        cooldownUntil: retryAfter,
      };
    }

    await setSettings({
      googleCalendarLastSyncAt: nowIso(),
      googleCalendarLastSyncStatus: "failed",
      googleCalendarLastSyncError: message,
    });
    throw error;
  } finally {
    await releaseGoogleCalendarSyncLock(lockToken);
  }
}

export async function syncGoogleCalendarIfEnabled() {
  const settings = await readSettings();
  if (settings.googleCalendarAutoSync === "false") {
    return { ...(await getGoogleCalendarSyncStatus()), ok: true, skipped: true, reason: "auto_sync_disabled" };
  }
  return syncGoogleCalendarNow();
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
      return json(await syncGoogleCalendarIfEnabled());
    }
    return json({ error: "method_not_allowed", message: "Use GET for status or POST to sync." }, 405);
  } catch (error: any) {
    console.error("google_calendar_sync:function_failed", error);
    return json(
      {
        error: "google_calendar_sync_error",
        message: error instanceof Error ? error.message : "Google Calendar sync failed.",
      },
      error?.status || 500,
    );
  }
}

export const config: Config = {
  path: "/api/google-calendar-sync",
};
