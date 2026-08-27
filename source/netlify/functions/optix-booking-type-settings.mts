import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";
import { requireCoachActor } from "./_shared/coach-auth.mts";

const SETTINGS_KEY = "optixBookingTypeConfigJson";
const PROFILES_KEY = "optixResourceProfilesJson";
const SESSION_COOKIE = "clarity_session";
const KNOWN_RESOURCE_IDS = new Set([
  "600009",
  "600004",
  "600005",
  "600006",
  "600007",
  "600008",
  "600010",
]);

function db() {
  return getDatabase();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseCookies(req: Request) {
  return Object.fromEntries(
    (req.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

/**
 * Optix booking-type mappings are per business, so this needs the business,
 * not "a session row exists" -- which is all the old check established, while
 * the settings it guarded were read and written globally.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
}

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((candidate) => String(candidate || "").trim())
      .filter((candidate) => KNOWN_RESOURCE_IDS.has(candidate)),
  )).slice(0, 7);
}

function cleanConfig(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([serviceId, raw]) => {
        const id = String(serviceId || "").trim().slice(0, 120);
        if (!id) return null;
        return [id, {
          enabled: raw?.enabled === true,
          // Book the Optix bay automatically once a client booking of this
          // lesson type lands on the calendar (see booking-core's public
          // booking side effects). Only meaningful alongside enabled: true.
          autoBook: raw?.autoBook === true,
          leftHanded: raw?.leftHanded === true,
          preferredResourceIds: cleanIds(raw?.preferredResourceIds),
          leftHandedResourceIds: cleanIds(raw?.leftHandedResourceIds),
        }];
      })
      .filter(Boolean) as Array<[string, unknown]>,
  );
}

function cleanProfiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((raw: any, index) => ({
    id: String(raw?.id || `profile-${index + 1}`).trim().slice(0, 80),
    name: String(raw?.name || `Resource profile ${index + 1}`).trim().slice(0, 120),
    handedness: raw?.handedness === "left" ? "left" : "standard",
    resourceIds: cleanIds(raw?.resourceIds),
    serviceIds: Array.isArray(raw?.serviceIds)
      ? Array.from(new Set(
          raw.serviceIds
            .map((id: unknown) => String(id || "").trim())
            .filter(Boolean),
        )).slice(0, 200)
      : [],
  })).filter((profile) => profile.id && profile.name && profile.resourceIds.length);
}

async function ensureSettingsTable() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS settings (
      account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id, key)
    )
  `;
}

async function readSetting(accountId: string, key: string) {
  await ensureSettingsTable();
  const rows = await db().sql`
    SELECT value FROM settings WHERE account_id = ${accountId} AND key = ${key}
  `;
  return rows[0]?.value || "";
}

async function readState(accountId: string) {
  let config = {};
  let profiles: any[] = [];
  try {
    config = cleanConfig(JSON.parse(await readSetting(accountId, SETTINGS_KEY) || "{}"));
  } catch {
    config = {};
  }
  try {
    profiles = cleanProfiles(JSON.parse(await readSetting(accountId, PROFILES_KEY) || "[]"));
  } catch {
    profiles = [];
  }
  return { config, profiles };
}

async function writeSetting(accountId: string, key: string, value: unknown) {
  await ensureSettingsTable();
  await db().sql`
    INSERT INTO settings (account_id, key, value, updated_at)
    VALUES (${accountId}, ${key}, ${JSON.stringify(value)}, NOW())
    ON CONFLICT (account_id, key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
  `;
}

async function writeState(accountId: string, value: any) {
  const profiles = cleanProfiles(value?.profiles);
  const config = cleanConfig(value?.config);
  await Promise.all([
    writeSetting(accountId, PROFILES_KEY, profiles),
    writeSetting(accountId, SETTINGS_KEY, config),
  ]);
  return { config, profiles };
}

export default async function handler(req: Request) {
  try {
    const accountId = await requireAccountId(req);
    if (req.method === "GET") return json(await readState(accountId));
    if (req.method === "PUT") {
      const raw = await req.text();
      const body = raw ? JSON.parse(raw) : {};
      return json(await writeState(accountId, body));
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return json(
        {
          error: (error as { code?: string })?.code || "unauthorized",
          message: error instanceof Error ? error.message : "Admin login required.",
        },
        status,
      );
    }
    console.error("optix_booking_type_settings:failed", error);
    return json({
      error: "optix_booking_type_settings_failed",
      message: error instanceof Error ? error.message : "Optix booking type settings failed.",
    }, 500);
  }
}

export const config: Config = { path: "/api/optix-booking-type-settings" };
