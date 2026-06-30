import type { Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { createHash } from "node:crypto";

const sessionCookieName = "clarity_session";
const DEFAULT_ACCOUNT_ID = "sam-hale-golf";

const planLimits: Record<string, { multiLocation: boolean; maxLocations: number }> = {
  solo: { multiLocation: false, maxLocations: 1 },
  studio: { multiLocation: true, maxLocations: 3 },
  academy: { multiLocation: true, maxLocations: 10 },
  enterprise: { multiLocation: true, maxLocations: 999 },
  founder: { multiLocation: true, maxLocations: 999 },
};

function db() {
  return getDatabase();
}

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
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

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function cleanSlug(value: unknown, fallback = DEFAULT_ACCOUNT_ID) {
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

function cleanUrl(value: unknown, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : fallback;
  } catch {
    return fallback;
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function safeErrorDetail(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  return raw.replace(/\s+/g, " ").slice(0, 700);
}

async function ensureSettingsTable() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

async function getSetting(key: string) {
  await ensureSettingsTable();
  const rows = await db().sql`SELECT value FROM settings WHERE key = ${key} LIMIT 1`;
  return typeof rows[0]?.value === "string" ? rows[0].value : "";
}

async function setSetting(key: string, value: unknown) {
  await ensureSettingsTable();
  await db().sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES (${key}, ${String(value ?? "")}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await db().sql`
    SELECT id
    FROM admin_sessions
    WHERE token_hash = ${hashToken(token)}
      AND expires_at > ${nowIso()}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function readAccountSettings() {
  const businessName = (await getSetting("accountBusinessName")) || "Sam Hale Golf";
  const calendarSlug = (await getSetting("accountCalendarSlug")) || cleanSlug(businessName, DEFAULT_ACCOUNT_ID);
  const accountId = (await getSetting("accountId")) || cleanSlug(calendarSlug || businessName, DEFAULT_ACCOUNT_ID);
  return {
    id: accountId,
    businessName,
    calendarSlug,
    venueName: (await getSetting("accountVenueName")) || "The Range 24/7 - Three Kings",
    venueShortName: (await getSetting("accountVenueShortName")) || "The Range 24/7",
    timezone: (await getSetting("accountTimezone")) || "Pacific/Auckland",
  };
}

function defaultWorkspaceAccount(account: Awaited<ReturnType<typeof readAccountSettings>>) {
  const slug = cleanSlug(account.calendarSlug || account.businessName, DEFAULT_ACCOUNT_ID);
  return {
    id: slug,
    name: account.businessName || "Sam Hale Golf",
    slug,
    planKey: "founder",
    subscriptionStatus: "comped",
    billingProvider: "none",
    active: true,
  };
}

function defaultLocation(account: Awaited<ReturnType<typeof readAccountSettings>>, accountId: string) {
  return {
    id: "default-location",
    accountId,
    name: account.venueName,
    shortName: account.venueShortName || account.venueName,
    address: "",
    timezone: account.timezone,
    active: true,
    archived: false,
    isDefault: true,
    sortOrder: 0,
  };
}

async function activeWorkspaceAccount() {
  const account = await readAccountSettings();
  const fallback = defaultWorkspaceAccount(account);
  const accounts = parseJson(await getSetting("workspaceAccountsJson"), [] as any[]);
  const source = Array.isArray(accounts) && accounts.length ? accounts : [fallback];
  return source.find((candidate) => candidate?.active !== false) || source[0] || fallback;
}

function cleanLocation(raw: any, fallback: ReturnType<typeof defaultLocation>, index = 0) {
  const name = cleanString(raw?.name, fallback.name, 140);
  const shortName = cleanString(raw?.shortName, name, 80);
  return {
    id: cleanSlug(raw?.id, cleanSlug(name, `location-${index + 1}`)),
    accountId: cleanSlug(raw?.accountId, fallback.accountId),
    name,
    shortName,
    address: cleanString(raw?.address, fallback.address || "", 240),
    mapUrl: cleanUrl(raw?.mapUrl, "") || undefined,
    arrivalInstructions: cleanString(raw?.arrivalInstructions, "", 500) || undefined,
    publicNotes: cleanString(raw?.publicNotes, "", 500) || undefined,
    timezone: cleanString(raw?.timezone, fallback.timezone, 80),
    active: raw?.active !== false,
    archived: raw?.archived === true,
    isDefault: raw?.isDefault === true,
    sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Math.round(Number(raw.sortOrder)) : index,
  };
}

async function normalizeLocations(rawLocations: unknown) {
  const account = await readAccountSettings();
  const workspaceAccount = await activeWorkspaceAccount();
  const accountId = cleanSlug(workspaceAccount.id, defaultWorkspaceAccount(account).id);
  const fallback = defaultLocation(account, accountId);
  const source = Array.isArray(rawLocations) && rawLocations.length ? rawLocations : [fallback];
  const seen = new Set<string>();
  const cleaned = source.map((raw, index) => {
    const location = cleanLocation(raw, index === 0 ? fallback : { ...fallback, isDefault: false }, index);
    let id = location.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${location.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    return { ...location, id, accountId };
  });
  if (!cleaned.some((location) => location.active && !location.archived)) {
    cleaned[0] = { ...cleaned[0], active: true, archived: false };
  }
  const defaultIndex = cleaned.findIndex((location) => location.isDefault && location.active && !location.archived);
  const nextDefaultIndex = defaultIndex >= 0 ? defaultIndex : cleaned.findIndex((location) => location.active && !location.archived);
  return cleaned
    .map((location, index) => ({ ...location, isDefault: index === nextDefaultIndex }))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
}

function assertLocationEntitlement(account: any, locations: Array<{ active?: boolean; archived?: boolean }>) {
  const status = account?.subscriptionStatus || "comped";
  if (["cancelled", "paused"].includes(status)) {
    throw Object.assign(new Error("This account is not active."), { status: 403 });
  }
  const plan = planLimits[account?.planKey || "founder"] || planLimits.founder;
  const activeCount = locations.filter((location) => location.active && !location.archived).length;
  if (activeCount > 1 && !plan.multiLocation) {
    throw Object.assign(new Error("Multiple locations are not included in this workspace plan."), { status: 403 });
  }
  if (activeCount > plan.maxLocations) {
    throw Object.assign(new Error(`This workspace plan allows ${plan.maxLocations} locations.`), { status: 403 });
  }
}

async function readLocations() {
  return normalizeLocations(parseJson(await getSetting("locationsJson"), [] as any[]));
}

async function writeLocations(rawLocations: unknown) {
  if (!Array.isArray(rawLocations)) {
    throw Object.assign(new Error("PUT /api/locations requires a locations array."), { status: 400 });
  }
  const workspaceAccount = await activeWorkspaceAccount();
  const locations = await normalizeLocations(rawLocations);
  assertLocationEntitlement(workspaceAccount, locations);
  await setSetting("locationsJson", JSON.stringify(locations));
  await setSetting("updatedAt", nowIso());
  return locations;
}

export default async function handler(req: Request) {
  try {
    if (!(await requireAdmin(req))) {
      return json({ error: "unauthorized", message: "Admin login required." }, 401);
    }

    if (req.method === "GET") {
      return json({ locations: await readLocations() });
    }

    if (req.method === "PUT") {
      const body = await req.json().catch(() => ({}));
      return json({ locations: await writeLocations(body?.locations) });
    }

    return json({ error: "method_not_allowed", message: "Method not allowed." }, 405);
  } catch (error) {
    console.error("locations:failed", error);
    const status = Number((error as { status?: unknown })?.status) || 500;
    return json(
      {
        error: status === 500 ? "locations_error" : "request_error",
        message: error instanceof Error ? error.message : "Location save failed.",
        details: safeErrorDetail(error),
      },
      status,
    );
  }
}

export const config: Config = {
  path: "/api/locations",
};
