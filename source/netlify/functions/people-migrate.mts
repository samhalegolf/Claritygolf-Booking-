import type { Config, Context } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";

import { getSupabaseDatabase } from "./supabase-storage.mts";

const sessionCookieName = "clarity_session";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function cleanString(value, fallback = "", max = 600) {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
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
          : [
              decodeURIComponent(pair.slice(0, index)),
              decodeURIComponent(pair.slice(index + 1)),
            ];
      }),
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

function cleanPerson(person: any, source = "client_migration") {
  if (!person || typeof person !== "object") return null;
  const joinedName = [person.firstName, person.lastName]
    .filter(Boolean)
    .join(" ");
  const name = cleanString(
    person.name || joinedName || person.client || person.title,
    "",
    180,
  );
  const email = cleanString(person.email, "", 180).toLowerCase();
  if (!name && !email) return null;
  return {
    id: cleanString(person.id, "", 120),
    name: name || email,
    email,
    phone: cleanString(person.phone, "", 80),
    notes: cleanString(person.notes || person.note, "", 1200),
    source: cleanString(person.source, source, 80),
    caddyProfileId: cleanString(
      person.caddyProfileId || person.caddyId,
      "",
      120,
    ),
    caddyProfileUrl: cleanString(
      person.caddyProfileUrl || person.caddyUrl,
      "",
      600,
    ),
  };
}

function personFromAppointment(item: any) {
  if (!item || item.kind !== "appointment") return null;
  return cleanPerson(
    {
      name: item.client || item.title,
      email: item.email,
      phone: item.phone,
      source: "appointment_migration",
    },
    "appointment_migration",
  );
}

function keyForPerson(person: any) {
  const name = cleanString(person?.name, "", 180)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const email = cleanString(person?.email, "", 180).toLowerCase();
  const phone = cleanString(person?.phone, "", 80).replace(/\D/g, "");

  // Contact methods are not a person's identity. Use a composite key so two
  // family members can share an email or phone without being collapsed.
  if (name && email) return `name-email:${name}|${email}`;
  if (name && phone) return `name-phone:${name}|${phone}`;
  if (email && phone) return `email-phone:${email}|${phone}`;
  if (email) return `email:${email}`;
  if (phone) return `phone:${phone}`;
  return `name:${name}`;
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return null;
  const rows = await getSupabaseDatabase().sql`
    SELECT admin_users.id, admin_users.email, admin_sessions.expires_at
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ${hashToken(token)}
  `;
  const session = rows[0];
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  return session;
}

async function migrateClients(rawPeople: any[] = []) {
  const db = getSupabaseDatabase();
  const items = await db.sql`
    SELECT * FROM calendar_items
    ORDER BY week, day, start, id
  `;
  const existingPeople = await db.sql`
    SELECT * FROM people
    ORDER BY LOWER(name), LOWER(email), id
  `;

  const existingByKey = new Map();
  for (const person of existingPeople) {
    existingByKey.set(
      keyForPerson({
        name: person.name || "",
        email: person.email || "",
        phone: person.phone || "",
      }),
      person,
    );
  }

  const candidates = [
    ...items.map(personFromAppointment).filter(Boolean),
    ...(Array.isArray(rawPeople)
      ? rawPeople
          .map((person) => cleanPerson(person, "manual_migration"))
          .filter(Boolean)
      : []),
  ];

  const deduped = new Map();
  for (const person of candidates) {
    const key = keyForPerson(person);
    if (!deduped.has(key)) deduped.set(key, person);
  }

  const client = await db.pool.connect();
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const person of deduped.values()) {
    const key = keyForPerson(person);
    const existing = existingByKey.get(key);
    if (existing) {
      await client.query(
        `UPDATE people
         SET name = $2,
             email = NULLIF($3, ''),
             phone = NULLIF($4, ''),
             notes = COALESCE(NULLIF($5, ''), notes),
             source = COALESCE(NULLIF($6, ''), source),
             caddy_profile_id = NULLIF($7, ''),
             caddy_profile_url = NULLIF($8, ''),
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.id,
          person.name,
          person.email,
          person.phone,
          person.notes,
          person.source,
          person.caddyProfileId,
          person.caddyProfileUrl,
        ],
      );
      updated += 1;
      continue;
    }

    if (!person.name && !person.email) {
      skipped += 1;
      continue;
    }

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
    imported += 1;
  }
  client.release();

  const people = await db.sql`
    SELECT * FROM people
    ORDER BY LOWER(name), LOWER(email), id
  `;

  return {
    ok: true,
    imported,
    updated,
    skipped,
    sourceCounts: {
      appointments: items.filter((item: any) => item.kind === "appointment")
        .length,
      provided: Array.isArray(rawPeople) ? rawPeople.length : 0,
    },
    people,
  };
}

export default async (req: Request, _context: Context) => {
  try {
    if (req.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    if (!(await requireAdmin(req))) {
      return json(
        { error: "unauthorized", message: "Admin login required." },
        401,
      );
    }
    const body = await parseBody(req);
    return json(await migrateClients(body.people), 201);
  } catch (error) {
    console.error("people_migrate_failed", error);
    return json(
      {
        error: "people_migrate_failed",
        message:
          error instanceof Error
            ? error.message
            : "Unknown client migration error",
      },
      500,
    );
  }
};

export const config: Config = {
  path: "/api/people/migrate",
};
