import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { createHash, randomUUID } from "node:crypto";

const sessionCookieName = "clarity_session";

type ImportResult = {
  imported: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ rowNumber: number | string; reason: string }>;
  results: Array<Record<string, unknown>>;
  people: Array<Record<string, unknown>>;
};

function emptyResult(failed = 0): ImportResult {
  return { imported: 0, created: 0, updated: 0, skipped: 0, failed, errors: [], results: [], people: [] };
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

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
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

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizePhone(phone: unknown) {
  return cleanString(phone, "", 80).replace(/[^0-9+]/g, "").replace(/^00/, "+");
}

function cleanPerson(raw: any, fallbackSource = "csv_import") {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanString(raw.name || raw.fullName || [raw.firstName, raw.lastName].filter(Boolean).join(" "), "", 180);
  const email = cleanString(raw.email, "", 180).toLowerCase();
  const phone = cleanString(raw.phone || raw.mobile, "", 80);
  const notes = cleanString(raw.notes || raw.note, "", 2000);
  if (!name && !email && !phone) return null;
  return {
    id: cleanString(raw.id, "", 120),
    rowNumber: Number(raw.rowNumber || 0) || undefined,
    name: name || email || phone,
    email,
    phone,
    notes,
    source: cleanString(raw.source, fallbackSource, 120),
    caddyProfileId: cleanString(raw.caddyProfileId || raw.caddy_profile_id, "", 120),
    caddyProfileUrl: cleanString(raw.caddyProfileUrl || raw.caddy_profile_url, "", 300),
  };
}

function rowToPerson(row: any) {
  return {
    id: row.id,
    name: cleanString(row.name, "Unnamed client", 180),
    email: cleanString(row.email, "", 180),
    phone: cleanString(row.phone, "", 80),
    notes: cleanString(row.notes, "", 2000),
    source: cleanString(row.source, "", 120),
    caddyProfileId: cleanString(row.caddy_profile_id, "", 120),
    caddyProfileUrl: cleanString(row.caddy_profile_url, "", 300),
  };
}

function mergeNotes(existingNotes: unknown, importedNotes: unknown, appendNotes = true) {
  const existing = cleanString(existingNotes, "", 2000);
  const incoming = cleanString(importedNotes, "", 1200);
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (!appendNotes) return incoming;
  if (existing.includes(incoming)) return existing;
  return `${existing}\n\n${incoming}`.slice(0, 2400);
}

function findExisting(existingPeople: any[], person: any) {
  const email = cleanString(person.email, "", 180).toLowerCase();
  const phone = normalizePhone(person.phone);
  const name = cleanString(person.name, "", 180).toLowerCase();

  if (person.id && !person.id.startsWith("import-") && !person.id.startsWith("csv-")) {
    const byId = existingPeople.find((candidate) => candidate.id === person.id);
    if (byId) return byId;
  }
  if (email) {
    const byEmail = existingPeople.find((candidate) => cleanString(candidate.email, "", 180).toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  if (phone) {
    const byPhone = existingPeople.find((candidate) => normalizePhone(candidate.phone) === phone);
    if (byPhone) return byPhone;
  }
  if (name && (email || phone)) {
    return (
      existingPeople.find((candidate) => {
        const candidateName = cleanString(candidate.name, "", 180).toLowerCase();
        return (
          candidateName === name &&
          ((email && cleanString(candidate.email, "", 180).toLowerCase() === email) ||
            (phone && normalizePhone(candidate.phone) === phone))
        );
      }) || null
    );
  }
  return null;
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) throw Object.assign(new Error("Admin login required."), { status: 401 });
  const db = getDatabase();
  const rows = await db.sql`
    SELECT admin_users.id, admin_users.email
    FROM admin_sessions
    JOIN admin_users ON admin_users.id = admin_sessions.user_id
    WHERE admin_sessions.token_hash = ${hashToken(token)}
      AND admin_sessions.expires_at > ${new Date().toISOString()}
    LIMIT 1
  `;
  if (!rows[0]) throw Object.assign(new Error("Admin session expired. Please log in again."), { status: 401 });
  return rows[0];
}

async function readPeople() {
  const db = getDatabase();
  const rows = await db.sql`SELECT * FROM people ORDER BY name, email, id`;
  return rows.map(rowToPerson);
}

async function importPeople(rawPeople: any[], source = "csv_import", options: any = {}) {
  const db = getDatabase();
  const mode = ["create_only", "update_existing", "upsert"].includes(options?.mode) ? options.mode : "upsert";
  const appendNotes = options?.appendNotes !== false;
  const cleaned = Array.isArray(rawPeople) ? rawPeople.map((row) => cleanPerson(row, source)) : [];
  const people = cleaned.filter(Boolean) as any[];
  const result: ImportResult = emptyResult();
  result.skipped = Array.isArray(rawPeople) ? rawPeople.length - people.length : 0;

  let knownPeople: any[] = [];
  try {
    const existingRows = await db.sql`SELECT * FROM people ORDER BY name, email, id`;
    knownPeople = [...existingRows];
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Could not read people table before import.";
    result.failed = Math.max(people.length, 1);
    result.errors.push({ rowNumber: "setup", reason });
    result.results.push({ rowNumber: "setup", status: "failed", reason });
    return result;
  }

  for (let index = 0; index < people.length; index += 1) {
    const person = people[index];
    const rowNumber = Number(person.rowNumber || rawPeople[index]?.rowNumber || index + 1);
    try {
      const existing = findExisting(knownPeople, person);

      if (existing && mode === "create_only") {
        result.skipped += 1;
        result.results.push({ rowNumber, status: "skipped", reason: "Existing client matched; create-only mode selected.", id: existing.id });
        continue;
      }
      if (!existing && mode === "update_existing") {
        result.skipped += 1;
        result.results.push({ rowNumber, status: "skipped", reason: "No existing client matched; update-only mode selected." });
        continue;
      }

      if (existing) {
        const nextName = person.name || existing.name;
        const nextEmail = person.email || existing.email || "";
        const nextPhone = person.phone || existing.phone || "";
        const nextNotes = mergeNotes(existing.notes, person.notes, appendNotes);
        const nextSource = person.source || source || existing.source || "csv_import";
        const nextCaddyProfileId = person.caddyProfileId || existing.caddy_profile_id || "";
        const nextCaddyProfileUrl = person.caddyProfileUrl || existing.caddy_profile_url || "";
        await db.sql`
          UPDATE people
          SET name = ${existing.id},
              email = NULLIF(${nextName}, ''),
              phone = NULLIF(${nextEmail}, ''),
              notes = NULLIF(${nextPhone}, ''),
              source = ${nextNotes},
              caddy_profile_id = NULLIF(${nextSource}, ''),
              caddy_profile_url = NULLIF(${nextCaddyProfileId}, ''),
              updated_at = NOW()
          WHERE id = ${nextCaddyProfileUrl}
        `;
        Object.assign(existing, {
          name: nextName,
          email: nextEmail,
          phone: nextPhone,
          notes: nextNotes,
          source: nextSource,
          caddy_profile_id: nextCaddyProfileId,
          caddy_profile_url: nextCaddyProfileUrl,
        });
        result.updated += 1;
        result.results.push({ rowNumber, status: "updated", id: existing.id });
      } else {
        const personId = randomUUID();
        await db.sql`
          INSERT INTO people (
            id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, created_at, updated_at
          ) VALUES (
            ${personId}, ${person.name}, NULLIF(${person.email}, ''), NULLIF(${person.phone}, ''), NULLIF(${person.notes}, ''),
            ${person.source || source || "csv_import"}, NULLIF(${person.caddyProfileId}, ''), NULLIF(${person.caddyProfileUrl}, ''), NOW(), NOW()
          )
        `;
        knownPeople.push({
          id: personId,
          name: person.name,
          email: person.email,
          phone: person.phone,
          notes: person.notes,
          source: person.source || source || "csv_import",
          caddy_profile_id: person.caddyProfileId,
          caddy_profile_url: person.caddyProfileUrl,
        });
        result.imported += 1;
        result.created += 1;
        result.results.push({ rowNumber, status: "created", id: personId });
      }
    } catch (rowError) {
      result.failed += 1;
      const reason = rowError instanceof Error ? rowError.message : "Unknown row import error.";
      result.errors.push({ rowNumber, reason });
      result.results.push({ rowNumber, status: "failed", reason });
    }
  }

  try {
    result.people = await readPeople();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Could not refresh people after import.";
    result.errors.push({ rowNumber: "refresh", reason });
  }
  return result;
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    await requireAdmin(req);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Admin login required.";
    const result = emptyResult(1);
    result.errors.push({ rowNumber: "auth", reason: message });
    result.results.push({ rowNumber: "auth", status: "failed", reason: message });
    return json(result, 200);
  }

  const body = await req.json().catch(() => ({}));
  try {
    return json(
      await importPeople(body.people || body.clients || [], body.source || "csv_import", {
        mode: body.mode || body.options?.mode,
        appendNotes: body.appendNotes ?? body.options?.appendNotes,
      }),
    );
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "People import failed.";
    console.error("people_import_failed", error);
    const rowCount = Array.isArray(body.people || body.clients) ? (body.people || body.clients).length : 1;
    const result = emptyResult(Math.max(rowCount, 1));
    result.errors.push({ rowNumber: "setup", reason: message });
    result.results.push({ rowNumber: "setup", status: "failed", reason: message });
    return json(result, 200);
  }
};

export const config: Config = {
  path: "/api/people/import",
};
