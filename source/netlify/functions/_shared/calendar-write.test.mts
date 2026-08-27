/**
 * The batched calendar item write, and the contact no-op check that sits beside
 * it.
 *
 * Both exist because a full calendar save used to cost one Postgres round trip
 * per item and three more per client derived from it. That is fine on a new
 * calendar and fatal on a year-old one: the save crossed the function timeout
 * and a coach booking a lesson got "Calendar save failed" on a booking that was
 * perfectly valid. These tests pin the two things that have to stay true for the
 * batch to be a safe swap for the loop — the parameters line up with the columns
 * and the JSON columns keep their casts — since getting either wrong writes the
 * wrong data into every row at once rather than failing loudly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { personRowUnchanged, setSettingsBulk, upsertCalendarItemChunk } from "../booking-core.mts";

/** Stands in for a pg client, capturing the statement instead of running it. */
function recordingClient() {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: [] };
    },
  };
}

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "appt-1",
  accountId: "clarity",
  kind: "appointment",
  week: 2,
  day: 3,
  start: 540,
  duration: 60,
  coachId: "coach-a",
  locationId: "bay-1",
  serviceId: "lesson-60",
  client: "Sam Hale",
  title: "Sam Hale",
  phone: "",
  email: "",
  personId: "",
  note: "",
  status: "booked",
  ...overrides,
});

test("a batch of items is one statement, not one per item", async () => {
  const client = recordingClient();
  await upsertCalendarItemChunk(client, [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })], "clarity");

  assert.equal(client.calls.length, 1, "three items still cost a single round trip");
  const { text, params } = client.calls[0];
  assert.equal(params.length, 60, "twenty columns per row");
  assert.equal(text.match(/NOW\(\), NOW\(\)\)/g)?.length, 3, "one value tuple per item");
});

test("every parameter lands in its own placeholder, numbered in order", async () => {
  const client = recordingClient();
  await upsertCalendarItemChunk(client, [item({ id: "a" }), item({ id: "b" })], "clarity");

  const { text, params } = client.calls[0];
  const placeholders = (text.match(/\$\d+/g) || []).map((token) => Number(token.slice(1)));
  assert.deepEqual(
    placeholders,
    params.map((_, index) => index + 1),
    "placeholders run 1..n with none repeated or skipped",
  );
  assert.equal(params[0], "a", "first row's id is the first parameter");
  assert.equal(params[20], "b", "second row starts one column-width later");
});

test("only the JSON columns are cast to jsonb", async () => {
  const client = recordingClient();
  await upsertCalendarItemChunk(
    client,
    [item({ coach: { coachId: "coach-a", name: "Sam Hale" }, location: { name: "Bay 1" } })],
    "clarity",
  );

  const { text, params } = client.calls[0];
  const cast = (text.match(/\$(\d+)::jsonb/g) || []).map((token) => Number(token.slice(1).split(":")[0]));
  assert.deepEqual(cast, [18, 19, 20], "custom_group, coach and location, and nothing else");
  // Anything cast to jsonb has to be sent as text Postgres can parse, or the
  // cast fails at runtime on a statement that looked fine here. An absent
  // snapshot is sent as null/undefined and stored as NULL, which the cast
  // accepts — that is the ordinary shape for a block.
  cast.forEach((position) => {
    const value = params[position - 1];
    if (value === null || value === undefined) return;
    assert.equal(typeof value, "string");
    assert.doesNotThrow(() => JSON.parse(value as string));
  });
  assert.equal(typeof params[18], "string", "a coach snapshot serialises");
  assert.equal(typeof params[19], "string", "a location snapshot serialises");
});

test("an item with no snapshots writes NULL rather than the string \"undefined\"", async () => {
  const client = recordingClient();
  await upsertCalendarItemChunk(client, [item({ kind: "block", title: "Busy" })], "clarity");

  const { params } = client.calls[0];
  [17, 18, 19].forEach((index) => {
    assert.ok(
      params[index] === null || params[index] === undefined,
      "an absent JSON column is a null parameter, never a serialised placeholder",
    );
  });
});

test("a conflicting row updates every column except the id it matched on", async () => {
  const client = recordingClient();
  await upsertCalendarItemChunk(client, [item()], "clarity");

  const { text } = client.calls[0];
  const updated = text.slice(text.indexOf("DO UPDATE SET"));
  ["account_id", "kind", "week", "day", "start", "duration", "status", "coach", "location"].forEach(
    (column) => assert.ok(updated.includes(`${column} = EXCLUDED.${column}`), `${column} is refreshed`),
  );
  assert.equal(updated.includes("id = EXCLUDED.id"), false, "the conflict key is not reassigned");
  assert.ok(updated.includes("updated_at = NOW()"), "the row is stamped");
});

test("an unchanged contact needs no write", () => {
  const stored = {
    name: "Sam Hale",
    email: "sam@example.com",
    phone: "021 555 0100",
    notes: "",
    source: "appointment",
    caddyProfileId: "",
    caddyProfileUrl: "",
    accountId: "clarity",
  };
  assert.equal(personRowUnchanged({ ...stored }, stored, "clarity", "appointment"), true);
});

test("fields the caller left empty never count as a change", () => {
  // The UPDATE uses COALESCE(NULLIF($n, ''), column), so an empty incoming value
  // cannot overwrite anything — treating it as a change would put back the round
  // trips this check exists to remove.
  const stored = {
    name: "Sam Hale",
    email: "sam@example.com",
    phone: "021 555 0100",
    notes: "Left handed",
    source: "import",
    caddyProfileId: "caddy-1",
    caddyProfileUrl: "https://example.com/caddy-1",
    accountId: "clarity",
  };
  const sparse = { name: "Sam Hale", email: "", phone: "", notes: "", accountId: "" };
  assert.equal(personRowUnchanged(sparse, stored, "clarity", "import"), true);
});

test("a real edit still writes", () => {
  const stored = {
    name: "Sam Hale",
    email: "sam@example.com",
    phone: "",
    notes: "",
    source: "appointment",
    caddyProfileId: "",
    caddyProfileUrl: "",
    accountId: "clarity",
  };

  assert.equal(personRowUnchanged({ name: "Samuel Hale" }, stored, "clarity", "appointment"), false);
  assert.equal(personRowUnchanged({ email: "new@example.com" }, stored, "clarity", "appointment"), false);
  assert.equal(personRowUnchanged({ phone: "021 555 0100" }, stored, "clarity", "appointment"), false);
  assert.equal(personRowUnchanged({ notes: "Left handed" }, stored, "clarity", "appointment"), false);
});

test("the account a contact belongs to is part of the comparison", () => {
  const stored = {
    name: "Sam Hale",
    email: "",
    phone: "",
    notes: "",
    source: "appointment",
    caddyProfileId: "",
    caddyProfileUrl: "",
    accountId: "clarity",
  };
  // No accountId on the incoming record means the caller's fallback applies, and
  // that fallback is what would be written.
  assert.equal(personRowUnchanged({ name: "Sam Hale" }, stored, "other-workspace", "appointment"), false);
  assert.equal(personRowUnchanged({ name: "Sam Hale" }, stored, "clarity", "appointment"), true);
});

test("the source a contact arrived from is part of the comparison", () => {
  const stored = {
    name: "Sam Hale",
    email: "",
    phone: "",
    notes: "",
    source: "import",
    caddyProfileId: "",
    caddyProfileUrl: "",
    accountId: "clarity",
  };
  assert.equal(personRowUnchanged({ name: "Sam Hale" }, stored, "clarity", "appointment"), false);
  assert.equal(personRowUnchanged({ name: "Sam Hale" }, stored, "clarity", "import"), true);
});

test("a group of settings is written in one statement", async () => {
  const statements: { text: string; params: unknown[] }[] = [];
  await setSettingsBulk(
    "clarity",
    { accountCoachName: "Sam Hale", accountCountry: "NZ", accountTimezone: "Pacific/Auckland" },
    async (text: string, params: unknown[]) => {
      statements.push({ text, params });
      return { rows: [] };
    },
  );

  assert.equal(statements.length, 1, "three keys still cost a single round trip");
  const { text, params } = statements[0];
  assert.deepEqual(params, [
    "clarity",
    "accountCoachName",
    "Sam Hale",
    "clarity",
    "accountCountry",
    "NZ",
    "clarity",
    "accountTimezone",
    "Pacific/Auckland",
  ]);
  const placeholders = (text.match(/\$\d+/g) || []).map((token) => Number(token.slice(1)));
  assert.deepEqual(placeholders, [1, 2, 3, 4, 5, 6, 7, 8, 9], "account/key/value triples stay in step");
  assert.ok(text.includes("DO UPDATE"), "an existing key is overwritten, not ignored");
  assert.ok(
    text.includes("ON CONFLICT (account_id, key)"),
    "the uniqueness boundary is the business plus the key, not the key alone",
  );
});

test("a settings write with no account is refused", async () => {
  // The old helper wrote into a globally-keyed table, so a caller that had lost
  // track of the business still wrote -- into everyone's settings.
  await assert.rejects(
    () => setSettingsBulk("", { accountCoachName: "Sam Hale" }, async () => ({ rows: [] })),
    /accountId is required/,
  );
});

test("settings with no keys to write skip the database entirely", async () => {
  let called = false;
  const run = async () => {
    called = true;
    return { rows: [] };
  };
  await setSettingsBulk("clarity", {}, run);
  await setSettingsBulk("clarity", null, run);
  assert.equal(called, false, "an empty update is not a statement with no values");
});

test("a null or undefined setting is stored as an empty string, not \"null\"", async () => {
  let captured: unknown[] = [];
  await setSettingsBulk(
    "clarity",
    { notificationEmail: null, smsFromNumber: undefined },
    async (_t, params) => {
      captured = params;
      return { rows: [] };
    },
  );
  assert.deepEqual(captured, ["clarity", "notificationEmail", "", "clarity", "smsFromNumber", ""]);
});
