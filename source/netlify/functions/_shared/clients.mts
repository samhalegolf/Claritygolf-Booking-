import { randomUUID } from "node:crypto";
import { canReadCalendarItem } from "./bookings.mts";
import { recordBelongsToAccountStrict } from "./coach-auth.mts";
import {
  assertAccountFeature,
  hasPermission,
  missingAccountScope,
  permissionDenied,
} from "./permissions.mts";
import { canonicalPhoneKey, cleanPhoneCountry, FALLBACK_PHONE_COUNTRY } from "./phone.mts";
import { db, getSetting, queryRows, setSetting } from "./settings-store.mts";
import { cleanSlug, cleanString, env, nowIso, safeJsonParse } from "./values.mts";

/**
 * Clients (the people table): cleaning a contact, matching a new one to an
 * existing one by email or phone, importing, updating, merging, and lesson
 * notes.
 *
 * Matching is the delicate part. The same person arrives from the booking
 * form, spreadsheet imports and the calendar in different shapes, and a missed
 * match means a duplicate client. See compatiblePersonMatch.
 */

function personMatchesCalendarItem(person, item) {
  const email = cleanString(person?.email, "", 180).toLowerCase();
  const phone = cleanString(person?.phone, "", 80).replace(/\D/g, "");
  const itemEmail = cleanString(item?.email, "", 180).toLowerCase();
  const itemPhone = cleanString(item?.phone, "", 80).replace(/\D/g, "");
  if (email && itemEmail && email === itemEmail) return true;
  if (phone && itemPhone && phone === itemPhone) return true;
  return false;
}

export function filterPeopleForContext(people, context, state) {
  const accountPeople = (people || []).filter((person) => recordBelongsToAccountStrict(person, context.accountId));
  if (context.isAdmin) return accountPeople;
  const visibleItems = (state.items || []).filter((item) => canReadCalendarItem(context, item, state));
  return accountPeople.filter((person) => visibleItems.some((item) => personMatchesCalendarItem(person, item)));
}

export function assertCanManagePerson(context, person, state) {
  assertAccountFeature(context.account, "clients");
  if (context.isAdmin) return;
  if (!hasPermission(context.user, "clients", "own")) {
    throw permissionDenied("You do not have permission to edit clients.");
  }
  if (!filterPeopleForContext([person], context, state).length) {
    throw permissionDenied("You do not have permission to edit this client.");
  }
}

// accountId is required. As an optional parameter defaulting to the original
// workspace, any caller that lost track of the business silently wrote a client
// into Sam Hale Golf.
function cleanPerson(person, source = "import", accountId: string) {
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
    // The server's account, full stop. This read `person.accountId || accountId`,
    // so a request body could name the business a client was filed under --
    // the forged-account-id case, for people.
    accountId: cleanSlug(accountId, ""),
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

export function normalizedPersonName(value) {
  return cleanString(value, "", 180).toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizedPersonEmail(value) {
  return cleanString(value, "", 180).toLowerCase();
}

// The country a bare national number (one with no leading +) is assumed to
// belong to. The deployment default comes from CLARITY_PHONE_COUNTRY; the
// workspace's own country setting overrides it. The active value lives in the
// shared phone module so the frontend and the server cannot drift apart.
export function defaultPhoneCountry() {
  return cleanPhoneCountry(env("CLARITY_PHONE_COUNTRY", FALLBACK_PHONE_COUNTRY));
}

// Phone numbers reach us in three shapes for the same person: the booking form
// captures the national form (0274637700), spreadsheet imports carry the
// international form (+64274637700), and Excel prefixes text cells with an
// apostrophe ('+64274637700). Comparing raw digits treated these as three
// different people, so compatiblePersonMatch missed an existing contact, fell
// through to INSERT, and collided with the account-scoped unique index on
// lower(email) — taking the caller's entire calendar save down with it. The
// shared module is the single source of truth the frontend uses too.
/**
 * The country this business's bare phone numbers belong to.
 *
 * One key rather than readSettingsMap(): this is called on paths that write a
 * person, and the bulk settings read is measured in tens of kilobytes. Falls
 * back to the deployment default, never to whatever another business set.
 */
export async function accountPhoneCountry(accountId: string) {
  return cleanPhoneCountry(
    await getSetting(cleanSlug(accountId, ""), "accountCountry"),
    defaultPhoneCountry(),
  );
}

export function normalizedPersonPhone(value, country) {
  return canonicalPhoneKey(cleanString(value, "", 80), cleanPhoneCountry(country, defaultPhoneCountry()));
}

/**
 * `country` decides what a bare national number means, so it has to be the
 * business's own -- and it used to come from a module-level value that belonged
 * to whichever business the warm instance served last. It is an argument now.
 * The frontend passes the same one from the same setting, which is what keeps
 * the two sides agreeing about whether two numbers are one person.
 */
export function compatiblePersonMatch(candidate, rows = [], country = defaultPhoneCountry()) {
  if (!candidate || !Array.isArray(rows) || !rows.length) return null;
  // A candidate with no business matches nobody. Falling back to the original
  // workspace here would have merged a second business's client into a
  // same-named client of the first.
  const accountId = cleanSlug(candidate.accountId, "");
  if (!accountId) return null;
  const scopedRows = rows.filter((row) => recordBelongsToAccountStrict(row, accountId));

  const candidateId = cleanString(candidate.id, "", 120);
  if (candidateId && !candidateId.startsWith("appointment-")) {
    const exactId = scopedRows.find((row) => String(row?.id || "") === candidateId);
    if (exactId) return exactId;
  }

  const name = normalizedPersonName(candidate.name);
  const email = normalizedPersonEmail(candidate.email);
  const phone = normalizedPersonPhone(candidate.phone, country);

  if (name && email) {
    const matches = scopedRows.filter(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        normalizedPersonEmail(row?.email) === email,
    );
    const exact = matches.find((row) => {
      const existingPhone = normalizedPersonPhone(row?.phone, country);
      return !phone || !existingPhone || phone === existingPhone;
    });
    if (exact) return exact;
  }

  if (name && phone) {
    const exact = scopedRows.find(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        normalizedPersonPhone(row?.phone, country) === phone,
    );
    if (exact) return exact;
  }

  // Use a lone contact-method match only when it is unambiguous and names do
  // not conflict. Shared family or organisation details must remain separate.
  if (email) {
    const matches = scopedRows.filter(
      (row) => normalizedPersonEmail(row?.email) === email,
    );
    if (matches.length === 1) {
      const only = matches[0];
      const existingName = normalizedPersonName(only?.name);
      const existingPhone = normalizedPersonPhone(only?.phone, country);
      if (
        (!name || !existingName || name === existingName) &&
        (!phone || !existingPhone || phone === existingPhone)
      ) {
        return only;
      }
    }
  }

  if (phone) {
    const matches = scopedRows.filter(
      (row) => normalizedPersonPhone(row?.phone, country) === phone,
    );
    if (matches.length === 1) {
      const only = matches[0];
      const existingName = normalizedPersonName(only?.name);
      if (!name || !existingName || name === existingName) return only;
    }
  }

  // A booking taken with a name and nothing else. Every check above needs an
  // email or a phone number, so a contact with neither fell through to null and
  // the caller minted a fresh person row -- one per booking, forever, for the
  // same walk-in. Match on the name alone, but only against rows that are
  // themselves contactless and only when exactly one exists: two people who
  // share a name are told apart by their contact details, and a row that has
  // some must not be silently absorbed by one that has none.
  if (name && !email && !phone) {
    const matches = scopedRows.filter(
      (row) =>
        normalizedPersonName(row?.name) === name &&
        !normalizedPersonEmail(row?.email) &&
        !normalizedPersonPhone(row?.phone, country),
    );
    if (matches.length === 1) return matches[0];
  }

  return null;
}

// personByEmail() and duplicatePersonEmailError() were removed on 14 July 2026.
// They existed to enforce one-person-per-email, which the unique index on
// lower(email) also enforced at the database level. Both are gone: an email
// address is a contact method, not an identity, and families, clubs and couples
// legitimately share one. Same-person merging is compatiblePersonMatch's job and
// happens on name plus a compatible phone or email — never on an email alone.
// Please do not reintroduce a "this email is taken" rule here.

// The client derived from a booking belongs to the booking's business.
export function personFromAppointment(item, accountId: string) {
  if (!item || item.kind !== "appointment") return null;
  return cleanPerson(
    {
      // A personId already stamped on the booking (see person_id on
      // calendar_items) is a stable link set up on a previous save. Carrying
      // it through here means importPeople's id-first match (see
      // compatiblePersonMatch) updates that same row instead of re-deriving
      // the link from name/email/phone, which used to spin off a duplicate,
      // disconnected profile whenever an edit changed any of those fields.
      id: item.personId,
      name: item.client || item.title,
      email: item.email,
      phone: item.phone,
      source: "appointment",
    },
    "appointment",
    accountId,
  );
}

// No fallback account id. A person row with no owner belongs to nobody and is
// invisible to every business, rather than joining whichever one happens to be
// reading. Migration C backfilled the legacy rows and made the column NOT NULL,
// so this only bites genuinely malformed data.
export function rowToPerson(row) {
  return {
    id: row.id,
    accountId: cleanSlug(row.account_id, ""),
    name: row.name,
    email: row.email || "",
    phone: row.phone || "",
    notes: row.notes || "",
    source: row.source || "",
    caddyProfileId: row.caddy_profile_id || "",
    caddyProfileUrl: row.caddy_profile_url || "",
    // TRUE only for people an inbound external booking created. They show in
    // the external booking clients list until merged or moved into the main
    // client list.
    external: row.external === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readPeople(accountId: string) {
  if (!accountId) return [];
  const rows = await db().sql`
    SELECT * FROM people
    WHERE account_id = ${accountId}
    ORDER BY LOWER(name), LOWER(email), id
  `;
  return rows.map(rowToPerson);
}

const LESSON_NOTES_SETTING_PREFIX = "lessonNotes.v1";

function lessonNotesSettingKey(accountId: string) {
  const scoped = cleanSlug(accountId, "");
  if (!scoped) throw missingAccountScope("lesson_notes");
  return `${LESSON_NOTES_SETTING_PREFIX}.${scoped}`;
}

function rowToLessonNote(note, fallbackAccountId: string) {
  const createdAt = cleanString(note?.createdAt || note?.created_at, "", 80) || nowIso();
  const updatedAt = cleanString(note?.updatedAt || note?.updated_at, "", 80) || createdAt;
  return {
    id: cleanString(note?.id, "", 120) || randomUUID(),
    accountId: cleanSlug(note?.accountId || note?.account_id, fallbackAccountId),
    playerId: cleanString(note?.playerId || note?.player_id, "", 160),
    playerName: cleanString(note?.playerName || note?.player_name, "", 180),
    lessonId: cleanString(note?.lessonId || note?.lesson_id, "", 160),
    calendarItemId: cleanString(note?.calendarItemId || note?.calendar_item_id, "", 160),
    title: cleanString(note?.title, "Lesson note", 180),
    body: cleanString(note?.body || note?.text || note?.note, "", 8000),
    source: cleanString(note?.source, "typed", 40) === "voice" ? "voice" : "typed",
    createdAt,
    updatedAt,
  };
}

export async function readLessonNotes(accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
  const raw = await getSetting(cleanAccountId, lessonNotesSettingKey(cleanAccountId));
  const parsed = safeJsonParse(raw, []);
  return Array.isArray(parsed)
    ? parsed
        .map((note) => rowToLessonNote(note, cleanAccountId))
        .filter((note) => note.playerId && note.body)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    : [];
}

export async function writeLessonNotes(notes, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
  const scopedNotes = Array.isArray(notes)
    ? notes
        .map((note) => rowToLessonNote(note, cleanAccountId))
        .filter((note) => note.playerId && note.body)
    : [];
  await setSetting(cleanAccountId, lessonNotesSettingKey(cleanAccountId), JSON.stringify(scopedNotes));
  return scopedNotes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function upsertLessonNote(rawNote, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
  const now = nowIso();
  const current = await readLessonNotes(cleanAccountId);
  const note = rowToLessonNote(
    {
      ...rawNote,
      accountId: cleanAccountId,
      id: rawNote?.id || randomUUID(),
      createdAt: rawNote?.createdAt || now,
      updatedAt: now,
    },
    cleanAccountId,
  );
  if (!note.playerId) {
    throw Object.assign(new Error("A lesson note needs a player id."), { status: 400 });
  }
  if (!note.body.trim()) {
    throw Object.assign(new Error("A lesson note cannot be empty."), { status: 400 });
  }
  const next = [note, ...current.filter((entry) => entry.id !== note.id)];
  const notes = await writeLessonNotes(next, cleanAccountId);
  return { note, notes };
}

export async function deleteLessonNote(noteId, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("lesson_notes");
  const cleanId = cleanString(noteId, "", 120);
  if (!cleanId) {
    throw Object.assign(new Error("A lesson note id is required."), { status: 400 });
  }
  const current = await readLessonNotes(cleanAccountId);
  const notes = await writeLessonNotes(current.filter((note) => note.id !== cleanId), cleanAccountId);
  return { notes };
}

/**
 * True when writing this person would leave the stored row exactly as it is.
 *
 * The UPDATE in importPeople sets each field with COALESCE(NULLIF($n, ''),
 * column), so an empty incoming value never overwrites anything and an equal one
 * writes back what is already there. Every full calendar save re-derives a
 * contact from every appointment on the calendar, and on an ordinary save none
 * of them differ — so this is the check that turns hundreds of round trips into
 * none. updated_at would move, but nothing reads it as a contact-changed signal.
 */
export function personRowUnchanged(person, existing, fallbackAccountId, source) {
  const matches = (incoming, current) => {
    const next = cleanString(incoming, "", 400);
    return !next || next === cleanString(current, "", 400);
  };
  return (
    matches(person.name, existing.name) &&
    matches(person.email, existing.email) &&
    matches(person.phone, existing.phone) &&
    matches(person.notes, existing.notes) &&
    matches(person.source || source, existing.source) &&
    matches(person.caddyProfileId, existing.caddyProfileId) &&
    matches(person.caddyProfileUrl, existing.caddyProfileUrl) &&
    // The account this write would actually use -- which is the caller's, not
    // the payload's, since the write paths stopped honouring person.accountId.
    matches(fallbackAccountId, existing.accountId)
  );
}

export async function importPeople(rawPeople, source = "import", accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("import_people");
  // Indexed (not filtered) so callers that need to stamp a resolved person id
  // back onto the record a given input came from (see resolvedIds below) can
  // line results up positionally with rawPeople, including the null/skipped
  // entries.
  const indexedPeople = Array.isArray(rawPeople)
    ? rawPeople.map((person) => cleanPerson(person, source, cleanAccountId))
    : [];
  const people = indexedPeople.filter(Boolean);
  const resolvedIds = indexedPeople.map(() => "");
  const result = {
    imported: 0,
    updated: 0,
    skipped: Array.isArray(rawPeople) ? rawPeople.length - people.length : 0,
    failed: 0,
    errors: [],
    people: [],
    resolvedIds,
  };
  if (!Array.isArray(rawPeople)) return result;

  // Read once for the whole import rather than per row: matching every incoming
  // person against the list needs the same country, and it is this business's.
  const phoneCountry = await accountPhoneCountry(cleanAccountId);

  const knownPeople = await readPeople(cleanAccountId);
  const knownById = new Map(knownPeople.map((row) => [row.id, row]));
  // Opened on the first person that actually needs writing. A full calendar save
  // re-derives a contact from every appointment on the calendar, and on a normal
  // save none of them have changed — see personRowUnchanged. Connecting and
  // running BEGIN/COMMIT for a transaction with no writes in it is pure latency
  // on a pool that only has three connections to hand out.
  let client = null;
  const openTransaction = async () => {
    if (!client) {
      client = await db().pool.connect();
      await client.query("BEGIN");
    }
    return client;
  };
  let personIndex = 0;
  try {
    for (let sourceIndex = 0; sourceIndex < indexedPeople.length; sourceIndex += 1) {
      const person = indexedPeople[sourceIndex];
      if (!person) continue;
      // A person id carried on the incoming record (an appointment's stored
      // person_id, see personFromAppointment) is an explicit, stable link set
      // up on a previous save. Trust it ahead of the fuzzy name/email/phone
      // heuristic below: compatiblePersonMatch already checks this id first,
      // but knownById lets us confirm the id still resolves to a real row
      // before treating the fuzzy match as a fallback.
      const linkedId = cleanString(person.id, "", 120);
      const linked = linkedId && !linkedId.startsWith("appointment-") ? knownById.get(linkedId) : null;
      const existing = linked || compatiblePersonMatch(person, knownPeople, phoneCountry);
      const existingId = existing?.id || "";

      // Already matches what is stored, so the UPDATE below would write the row
      // back to itself. Skip it: this is the case for nearly every contact on
      // nearly every save, and the round trips it saves are the difference
      // between a save that lands and one that times out.
      if (existingId && personRowUnchanged(person, existing, cleanAccountId, source)) {
        result.updated += 1;
        resolvedIds[sourceIndex] = existingId;
        continue;
      }

      // Every person write gets its own savepoint. Deriving contacts from
      // appointments is housekeeping that rides along with the caller's save;
      // when one contact cannot be reconciled (for example its email already
      // belongs to another row under the account-scoped unique index) it must
      // not abort the transaction and take the lesson the coach just booked
      // down with it. Previously a single duplicate contact rolled back the
      // whole calendar save and surfaced as a 409 the coach could not act on.
      const savepoint = `person_${personIndex}`;
      personIndex += 1;
      await (await openTransaction()).query(`SAVEPOINT ${savepoint}`);
      try {
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
	               account_id = COALESCE(NULLIF($9, ''), account_id),
	               updated_at = NOW()
	           WHERE id = $1`,
	          [
            existingId,
            person.name,
            person.email,
            person.phone,
            person.notes,
	            person.source || source,
	            person.caddyProfileId,
	            person.caddyProfileUrl,
              cleanAccountId,
	          ],
	        );
	        Object.assign(existing, {
            accountId: cleanAccountId,
	          name: person.name || existing.name,
          email: person.email || existing.email,
          phone: person.phone || existing.phone,
          notes: person.notes || existing.notes,
          source: person.source || source || existing.source,
          caddyProfileId: person.caddyProfileId || existing.caddyProfileId,
          caddyProfileUrl: person.caddyProfileUrl || existing.caddyProfileUrl,
        });
        result.updated += 1;
        resolvedIds[sourceIndex] = existingId;
      } else {
        const personId = linkedId && !linkedId.startsWith("appointment-") ? linkedId : randomUUID();
	        await client.query(
	          `INSERT INTO people (
	             id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, account_id, created_at, updated_at
	           ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NOW(), NOW())`,
	          [
            personId,
            person.name,
            person.email,
            person.phone,
            person.notes,
	            person.source || source,
	            person.caddyProfileId,
	            person.caddyProfileUrl,
              cleanAccountId,
	          ],
	        );
        const created = { ...person, id: personId };
        knownPeople.push(created);
        knownById.set(personId, created);
        result.imported += 1;
        resolvedIds[sourceIndex] = personId;
      }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        const message = error instanceof Error ? error.message : String(error || "");
        result.failed += 1;
        result.errors.push({
          name: person.name || "",
          email: person.email || "",
          reason: /duplicate key|idx_people_.*email/i.test(message)
            ? "A contact in this account already uses that email address."
            : message.slice(0, 300),
        });
        console.warn("people_import_person_skipped", {
          source,
          accountId: cleanAccountId,
          name: person.name || "",
          email: person.email || "",
          message: message.slice(0, 300),
        });
      }
    }
    if (client) await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (client) client.release();
  }

  result.people = await readPeople(cleanAccountId);
  return result;
}

export async function updatePerson(rawPerson, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("update_person");
  const person = cleanPerson(rawPerson, "manual_update", cleanAccountId);
  if (!person) {
    const error = new Error("A person needs a name or email.");
    error.status = 400;
    throw error;
  }

  const knownPeople = await readPeople(cleanAccountId);
  const existing = compatiblePersonMatch(person, knownPeople, await accountPhoneCountry(cleanAccountId));
  const existingId = existing?.id || "";
  const personId =
    existingId ||
    (person.id && !person.id.startsWith("appointment-")
      ? person.id
      : randomUUID());

  // No email-ownership check. A parent booking for two children, a club booking
  // for its players, a couple sharing an inbox — all use one address for several
  // people, and refusing the second one is wrong. compatiblePersonMatch above has
  // already merged this record into an existing contact if it genuinely is the
  // same person (matching name with a compatible phone or email); if it did not,
  // this is a different person who happens to share an address, and they are
  // entitled to their own row.

  const client = await db().pool.connect();
  try {
    await client.query("BEGIN");
    if (existingId) {
      const emailUnchanged =
        normalizedPersonEmail(existing?.email) === normalizedPersonEmail(person.email);
      // One statement whether or not the email changed: $10 says which. Two
      // statements used to share one parameter list, and the one that leaves
      // the email alone never mentioned $3 -- which Postgres refuses outright
      // ("could not determine data type of parameter $3"), so editing a
      // client without changing their email failed.
      await client.query(
        `UPDATE people
         SET name = $2,
             email = CASE WHEN $10::boolean THEN email ELSE NULLIF($3, '') END,
             phone = NULLIF($4, ''),
             notes = NULLIF($5, ''),
             source = COALESCE(NULLIF($6, ''), source),
             caddy_profile_id = NULLIF($7, ''),
             caddy_profile_url = NULLIF($8, ''),
             account_id = COALESCE(NULLIF($9, ''), account_id),
             updated_at = NOW()
         WHERE id = $1`,
        [
          personId,
          person.name,
          person.email,
          person.phone,
          person.notes,
          person.source,
          person.caddyProfileId,
          person.caddyProfileUrl,
          cleanAccountId,
          emailUnchanged,
        ],
      );
    } else {
	      await client.query(
	        `INSERT INTO people (
	          id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url, account_id, created_at, updated_at
	        ) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NOW(), NOW())`,
	        [
          personId,
          person.name,
          person.email,
          person.phone,
          person.notes,
	          person.source,
	          person.caddyProfileId,
	          person.caddyProfileUrl,
            cleanAccountId,
	        ],
	      );
    }

    const saved = await client.query(
      "SELECT * FROM people WHERE id = $1 LIMIT 1",
      [personId],
    );
    await client.query("COMMIT");
    return { person: rowToPerson(saved.rows[0]), people: await readPeople(cleanAccountId) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function mergePeople(rawSurvivorId, rawLoserId, fieldOverrides = {}, accountId: string) {
  const cleanAccountId = cleanSlug(accountId, "");
  if (!cleanAccountId) throw missingAccountScope("merge_people");
  const survivorId = cleanString(rawSurvivorId, "", 120);
  const loserId = cleanString(rawLoserId, "", 120);
  if (!survivorId || !loserId || survivorId === loserId) {
    throw Object.assign(new Error("Two different clients are required to merge."), {
      status: 400,
      code: "PEOPLE_MERGE_INVALID_IDS",
    });
  }

  const knownPeople = await readPeople(cleanAccountId);
  const survivorRow = knownPeople.find((person) => person.id === survivorId);
  const loserRow = knownPeople.find((person) => person.id === loserId);
  if (!survivorRow || !loserRow) {
    throw Object.assign(new Error("One of the selected clients could not be found."), {
      status: 404,
      code: "PEOPLE_MERGE_NOT_FOUND",
    });
  }

  const merged = cleanPerson({ ...survivorRow, ...fieldOverrides, id: survivorId }, survivorRow.source, cleanAccountId);
  if (!merged) {
    throw Object.assign(new Error("The merged client needs a name or email."), {
      status: 400,
      code: "PEOPLE_MERGE_INVALID_FIELDS",
    });
  }

  const client = await db().pool.connect();
  let mergedItemIds = [];
  let mergedExternalBookingIds = [];
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE people
       SET name = $2,
           email = NULLIF($3, ''),
           phone = NULLIF($4, ''),
           notes = NULLIF($5, ''),
           caddy_profile_id = NULLIF($6, ''),
           caddy_profile_url = NULLIF($7, ''),
           updated_at = NOW()
       WHERE id = $1`,
      [survivorId, merged.name, merged.email, merged.phone, merged.notes, merged.caddyProfileId, merged.caddyProfileUrl],
    );
    const reassigned = await client.query(
      "UPDATE calendar_items SET person_id = $1, updated_at = NOW() WHERE person_id = $2 RETURNING id",
      [survivorId, loserId],
    );
    mergedItemIds = queryRows(reassigned).map((row) => row.id);
    // Both tables below are created outside ensureSchema() — one by a migration,
    // one lazily on first player login — so a database that has never needed
    // them is not an error and must not abort the merge.
    // Same question as the module-level tableExists(), asked on the pooled
    // client this transaction is already holding rather than on a new one.
    const tableExistsHere = async (table) =>
      Boolean(
        queryRows(await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]))[0]?.name,
      );
    // External providers resolve the customer from their own link row, and
    // processStoredExternalEvent() prefers that value over the calendar item. Left
    // behind, the next inbound event would write the deleted loser id straight
    // back onto the booking and silently undo this merge.
    if (await tableExistsHere("external_booking_links")) {
      const relinked = await client.query(
        "UPDATE external_booking_links SET person_id = $1, updated_at = NOW() WHERE person_id = $2 RETURNING external_booking_id",
        [survivorId, loserId],
      );
      mergedExternalBookingIds = queryRows(relinked).map((row) => row.external_booking_id);
    }
    // A live player session carries the person id into playerProfileIdCandidates(),
    // which is what selects the portal's lesson notes. The notes move to the
    // survivor below, so a session left on the loser id would show the customer
    // an empty notes list until their next sign-in. No updated_at on this table.
    if (await tableExistsHere("player_sessions")) {
      await client.query(
        "UPDATE player_sessions SET person_id = $1 WHERE person_id = $2",
        [survivorId, loserId],
      );
    }
    // Optix sales carry no email, so they are the records most likely to be
    // sitting on a duplicate person in the first place — which makes them the
    // ones a merge most needs to move. There is no foreign key on this column,
    // so leaving them behind does not fail loudly: the purchase would simply
    // point at a deleted person id and drop out of the client's history with
    // nothing to show it had ever been linked.
    if (await tableExistsHere("optix_pass_purchases")) {
      await client.query(
        "UPDATE optix_pass_purchases SET person_id = $1, updated_at = NOW() WHERE person_id = $2",
        [survivorId, loserId],
      );
    }
    await client.query("DELETE FROM people WHERE id = $1", [loserId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Lesson notes live in a per-account settings JSON blob (see
  // LESSON_NOTES_SETTING_PREFIX), not a SQL table, so they can't be reassigned
  // inside the transaction above. Do it right after the transaction commits so
  // a note is never left pointing at a person id that no longer exists.
  const currentNotes = await readLessonNotes(cleanAccountId);
  const mergedNoteIds = currentNotes.filter((note) => note.playerId === loserId).map((note) => note.id);
  if (mergedNoteIds.length) {
    await writeLessonNotes(
      currentNotes.map((note) => (note.playerId === loserId ? { ...note, playerId: survivorId } : note)),
      cleanAccountId,
    );
  }

  const savedRows = await db().sql`SELECT * FROM people WHERE id = ${survivorId} LIMIT 1`;
  return {
    person: rowToPerson(savedRows[0]),
    removedPersonId: loserId,
    mergedItemIds,
    mergedExternalBookingIds,
    mergedNoteIds,
    people: await readPeople(cleanAccountId),
  };
}
