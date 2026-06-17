import type { Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { createHash, randomUUID } from "node:crypto";

const sessionCookieName = "clarity_session";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
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

function db() {
  return getDatabase();
}

async function ensurePeopleTables() {
  await db().sql`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      notes TEXT,
      source TEXT,
      caddy_profile_id TEXT,
      caddy_profile_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await db().sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_people_email_unique
    ON people (LOWER(email))
    WHERE email IS NOT NULL AND email <> ''
  `;
  await db().sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await db().sql`
    SELECT id
    FROM admin_sessions
    WHERE token_hash = ${hashToken(token)}
      AND expires_at > NOW()
    LIMIT 1
  `;
  return rows.length > 0;
}

function cleanPerson(person: any, index: number) {
  const name = cleanString(person?.name || [person?.firstName, person?.lastName].filter(Boolean).join(" "), "", 180);
  const email = cleanString(person?.email, "", 180).toLowerCase();
  if (!name && !email) return null;
  return {
    id: cleanString(person?.id, `csv-${randomUUID()}`, 140),
    name: name || email,
    email,
    phone: cleanString(person?.phone, "", 80),
    notes: cleanString(person?.notes || person?.note, "", 1200),
    source: cleanString(person?.source, "csv_import", 80),
    caddyProfileId: cleanString(person?.caddyProfileId || person?.caddyId, "", 120),
    caddyProfileUrl: cleanString(person?.caddyProfileUrl || person?.caddyUrl, "", 600),
  };
}

async function importPeople(rawPeople: any[]) {
  const people = Array.isArray(rawPeople) ? rawPeople.map(cleanPerson).filter(Boolean) : [];
  const result = {
    imported: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
  };

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    for (const person of people) {
      let existingId = "";
      if (person.email) {
        const existing = await client.query("SELECT id FROM people WHERE LOWER(email) = LOWER($1) LIMIT 1", [person.email]);
        existingId = existing.rows[0]?.id || "";
      }
      if (!existingId && person.phone) {
        const existing = await client.query(
          "SELECT id FROM people WHERE LOWER(name) = LOWER($1) AND phone = $2 LIMIT 1",
          [person.name, person.phone],
        );
        existingId = existing.rows[0]?.id || "";
      }
      if (!existingId && person.id) {
        const existing = await client.query("SELECT id FROM people WHERE id = $1 LIMIT 1", [person.id]);
        existingId = existing.rows[0]?.id || "";
      }

      if (existingId) {
        await client.query(
          `UPDATE people
           SET name = COALESCE(NULLIF($2, ''), name),
               email = COALESCE(NULLIF($3, ''), email),
               phone = COALESCE(NULLIF($4, ''), phone),
               notes = COALESCE(NULLIF($5, ''), notes),
               source = COALESCE(NULLIF($6, ''), source),
               caddy_profile_id = COALESCE(NULLIF($7, ''), caddy_profile_id),
               caddy_profile_url = COALESCE(NULLIF($8, ''), caddy_profile_url),
               updated_at = NOW()
           WHERE id = $1`,
          [
            existingId,
            person.name,
            person.email,
            person.phone,
            person.notes,
            person.source,
            person.caddyProfileId,
            person.caddyProfileUrl,
          ],
        );
        result.updated += 1;
      } else {
        await client.query(
          `INSERT INTO people (
             id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
           ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NOW(), NOW())`,
          [
            person.id || randomUUID(),
            person.name,
            person.email,
            person.phone,
            person.notes,
            person.source,
            person.caddyProfileId,
            person.caddyProfileUrl,
          ],
        );
        result.imported += 1;
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req: Request) {
  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    await ensurePeopleTables();
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);
    const body = await req.json().catch(() => ({}));
    const result = await importPeople(Array.isArray(body?.people) ? body.people : []);
    return json({ ok: true, ...result });
  } catch (error) {
    console.error("people_import_lite_failed", error);
    return json(
      { error: "people_import_lite_failed", message: error instanceof Error ? error.message : "People import failed." },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/people/import-lite",
};
