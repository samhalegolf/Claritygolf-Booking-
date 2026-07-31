import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

const SETTINGS_KEY = "optixBookingTypeConfigJson";
const SESSION_COOKIE = "clarity_session";
const KNOWN_RESOURCE_IDS = new Set([
  "600009", // Bay #1
  "600004", // Bay #2
  "600005", // Bay #3
  "600006", // Bay #4
  "600007", // Bay #5
  "600008", // Bay #6
  "600010", // Bay #7
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

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[SESSION_COOKIE] || "";
  if (!token) return false;
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const rows = await db().sql`
    SELECT id
    FROM admin_sessions
    WHERE token_hash = ${tokenHash}
      AND expires_at > NOW()
    LIMIT 1
  `;
  return rows.length > 0;
}

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((candidate) => String(candidate || "").trim())
        .filter((candidate) => KNOWN_RESOURCE_IDS.has(candidate)),
    ),
  ).slice(0, 7);
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
          leftHanded: raw?.leftHanded === true,
          preferredResourceIds: cleanIds(raw?.preferredResourceIds),
          leftHandedResourceIds: cleanIds(raw?.leftHandedResourceIds),
        }];
      })
      .filter(Boolean) as Array<[string, unknown]>,
  );
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

async function readConfig() {
  await ensureSettingsTable();
  const rows = await db().sql`SELECT value FROM settings WHERE key = ${SETTINGS_KEY}`;
  try {
    return cleanConfig(JSON.parse(rows[0]?.value || "{}"));
  } catch {
    return {};
  }
}

async function writeConfig(value: unknown) {
  const config = cleanConfig(value);
  await ensureSettingsTable();
  await db().sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES (${SETTINGS_KEY}, ${JSON.stringify(config)}, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
  `;
  return config;
}

export default async function handler(req: Request) {
  try {
    if (!(await requireAdmin(req))) {
      return json({ error: "unauthorized", message: "Admin login required." }, 401);
    }
    if (req.method === "GET") return json({ config: await readConfig() });
    if (req.method === "PUT") {
      const raw = await req.text();
      const body = raw ? JSON.parse(raw) : {};
      return json({ config: await writeConfig(body?.config || body) });
    }
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    console.error("optix_booking_type_settings:failed", error);
    return json({
      error: "optix_booking_type_settings_failed",
      message: error instanceof Error ? error.message : "Optix booking type settings failed.",
    }, 500);
  }
}

export const config: Config = { path: "/api/optix-booking-type-settings" };
