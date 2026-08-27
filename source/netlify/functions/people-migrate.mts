import type { Config, Context } from "@netlify/functions";
import { randomUUID } from "node:crypto";

import { getDatabase } from "@netlify/database";
import { requireCoachActor } from "./_shared/coach-auth.mts";


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

/**
 * The business whose clients are being migrated.
 *
 * This route used to check only that a session row existed, then read every
 * business's calendar items and people and write person rows with no owner at
 * all. It now runs inside one business, resolved the same way every other
 * private route resolves it.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
}

async function migrateClients(accountId: string, rawPeople: any[] = []) {
  const db = getDatabase();
  const items = await db.sql`
    SELECT * FROM calendar_items
    WHERE account_id = ${accountId}
    ORDER BY week, day, start, id
  `;
  const existingPeople = await db.sql`
    SELECT * FROM people
    WHERE account_id = ${accountId}
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
         WHERE id = $1
           AND account_id = $9`,
        [
          existing.id,
          person.name,
          person.email,
          person.phone,
          person.notes,
          person.source,
          person.caddyProfileId,
          person.caddyProfileUrl,
          accountId,
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
        id, account_id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
      ) VALUES ($1, $9, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NOW(), NOW())`,
      [
        person.id || randomUUID(),
        person.name,
        person.email,
        person.phone,
        person.notes,
        person.source,
        person.caddyProfileId,
        person.caddyProfileUrl,
        accountId,
      ],
    );
    imported += 1;
  }
  client.release();

  const people = await db.sql`
    SELECT * FROM people
    WHERE account_id = ${accountId}
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
    const accountId = await requireAccountId(req);
    const body = await parseBody(req);
    return json(await migrateClients(accountId, body.people), 201);
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
