/**
 * The business-account boundary.
 *
 * Every test here is a failure mode the app had before the boundary migration,
 * written the way it would actually bite: a second business's owner signs in
 * and sees the first business's data, or a broken write is quietly filed under
 * the first business.
 *
 * The rule these pin down is:
 *
 *   authenticated Supabase user -> active account_memberships row
 *     -> authoritative account_id -> every account-owned read and write
 *
 * and its corollary: missing ownership fails closed. Authenticated is not
 * authorised, and no runtime path may assign the original workspace as a
 * fallback.
 *
 * The database is stood in for so the assertions can be about the SQL that is
 * actually issued. That matters more than it sounds: the old calendar shell
 * read every business's rows and filtered them in JavaScript afterwards, which
 * looked correct from the outside right up until the filter was wrong.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "./database.mts";
import {
  recordBelongsToAccountStrict,
  requireCoachActor,
  resolvePublicAccount,
  userBelongsToAccountStrict,
} from "./coach-auth.mts";
import {
  availabilityFromSettings,
  calendarItemBelongsToAccount,
  calendarItemParams,
  coachAccountFromSettings,
  filterCalendarStateForContext,
  getSetting,
  publicAppointmentContactQuery,
  publicAppointmentReadQuery,
  publicSlotCalendarItemsQuery,
  readCalendarItemById,
  readItems,
  readPeople,
  readSettingsMap,
  servicesFromSettings,
  setSettingsBulk,
  writeItems,
} from "../booking-core.mts";

const BUSINESS_A = "sam-hale-golf";
const BUSINESS_B = "boundary-test-business";

/** The SQL a fake run issued, so a test can assert on the statement itself. */
type Issued = { text: string; values: unknown[] };

/**
 * Stands in for the database.
 *
 * `rows` decides what a statement answers with; it is given the normalised SQL
 * and the parameters, so a fixture can behave like a real table (return only
 * the rows whose account matches the one in the WHERE clause) or like a broken
 * one (return everything) to prove the caller is not relying on post-filtering.
 */
function fakeDatabase(rows: (text: string, values: unknown[]) => unknown[]) {
  const issued: Issued[] = [];
  const record = (text: string, values: unknown[]) => {
    issued.push({ text: text.replace(/\s+/g, " ").trim(), values });
    return rows(text.replace(/\s+/g, " ").trim(), values);
  };
  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = "";
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) text += `$${index + 1}`;
      });
      return record(text, values);
    },
    pool: {
      async query(text: string, values: unknown[] = []) {
        return { rows: record(text, values) };
      },
      async connect() {
        return {
          async query(text: string, values: unknown[] = []) {
            return { rows: record(text, values) };
          },
          release() {},
        };
      },
    },
  });
  return issued;
}

function restoreDatabase() {
  setDatabaseForTests(null);
}

function sessionRequest(token = "session-token") {
  return new Request("https://example.test/api/calendar-state", {
    headers: { cookie: `clarity_session=${token}` },
  });
}

// --- Test 1: authenticated is not authorised -------------------------------

test("an authenticated user with no membership is refused, not given the original business", async () => {
  // A real Supabase user with a valid session, and no account_memberships row.
  // This used to fall through readCurrentSessionUser's chain -- match by email,
  // else any admin on the default account, else a manufactured default admin --
  // and land inside Sam Hale Golf.
  const issued = fakeDatabase((text) => {
    if (text.includes("FROM admin_sessions")) {
      return [
        {
          auth_user_id: "11111111-1111-1111-1111-111111111111",
          user_id: "admin-1",
          email: "owner@business-b.test",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ];
    }
    if (text.includes("FROM account_memberships")) return [];
    return [];
  });
  try {
    await assert.rejects(
      () => requireCoachActor(sessionRequest()),
      (error: any) => error?.status === 403 && error?.code === "membership_required",
    );
    // And it really did ask about membership rather than assuming one.
    assert.ok(issued.some((statement) => statement.text.includes("FROM account_memberships")));
  } finally {
    restoreDatabase();
  }
});

test("no session at all is a 401, distinct from having no membership", async () => {
  const issued = fakeDatabase(() => []);
  try {
    await assert.rejects(
      () => requireCoachActor(new Request("https://example.test/api/calendar-state")),
      (error: any) => error?.status === 401 && error?.code === "unauthorized",
    );
    assert.equal(issued.length, 0, "a request with no cookie never reaches the database");
  } finally {
    restoreDatabase();
  }
});

test("the membership row, not the session, decides the account", async () => {
  const issued = fakeDatabase((text) => {
    if (text.includes("FROM admin_sessions")) {
      return [
        {
          auth_user_id: "22222222-2222-2222-2222-222222222222",
          user_id: "admin-2",
          email: "owner@business-b.test",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ];
    }
    if (text.includes("FROM account_memberships")) {
      return [{ id: "m-1", account_id: BUSINESS_B, role: "owner", coach_id: "coach-b" }];
    }
    return [];
  });
  try {
    const actor = await requireCoachActor(sessionRequest());
    assert.equal(actor.accountId, BUSINESS_B);
    assert.equal(actor.role, "owner");
    assert.equal(actor.isOwner, true);
    assert.equal(actor.isAdmin, true);
    // The membership lookup is keyed on the Supabase identity, never on the
    // email or the legacy admin_users id.
    const membershipRead = issued.find((statement) => statement.text.includes("FROM account_memberships"));
    assert.deepEqual(membershipRead?.values, ["22222222-2222-2222-2222-222222222222"]);
  } finally {
    restoreDatabase();
  }
});

// --- Test 2: one business's calendar ---------------------------------------

test("the calendar read filters by account in SQL, not in JavaScript afterwards", async () => {
  // The fixture deliberately answers with both businesses' rows. If the caller
  // were relying on a post-read filter this test would still pass on the row
  // count and fail on the statement -- which is the point: the boundary has to
  // be in the query.
  const issued = fakeDatabase(() => [
    { id: "a-1", account_id: BUSINESS_A, kind: "appointment", week: 0, day: 1, start: 540, duration: 60, title: "A" },
    { id: "b-1", account_id: BUSINESS_B, kind: "appointment", week: 0, day: 1, start: 600, duration: 60, title: "B" },
  ]);
  try {
    await readItems(BUSINESS_B);
    const read = issued.find((statement) => statement.text.includes("FROM calendar_items"));
    assert.ok(read, "the calendar was read");
    assert.match(read!.text, /WHERE ci\.account_id = \$1/);
    assert.deepEqual(read!.values, [BUSINESS_B]);
  } finally {
    restoreDatabase();
  }
});

test("Business B's calendar state contains only Business B's bookings", () => {
  const state = {
    accountId: BUSINESS_B,
    items: [
      { id: "a-1", accountId: BUSINESS_A, kind: "appointment", week: 0, day: 1, start: 540, duration: 60 },
      { id: "b-1", accountId: BUSINESS_B, kind: "appointment", week: 0, day: 1, start: 600, duration: 60 },
    ],
    services: [],
    coaches: [],
    locations: [],
    people: [],
    notifications: [],
    availability: [],
  };
  const context = {
    accountId: BUSINESS_B,
    account: { id: BUSINESS_B, active: true, planKey: "founder", subscriptionStatus: "comped" },
    user: { id: "u-b", accountId: BUSINESS_B, role: "admin", permissions: { calendar: "all" } },
    isAdmin: true,
  };
  const filtered = filterCalendarStateForContext(state, context);
  assert.deepEqual(filtered.items.map((item: any) => item.id), ["b-1"]);
});

// --- Test 3: a row with no owner belongs to nobody --------------------------

test("a calendar row with no account is visible to nobody", () => {
  const orphan = { id: "orphan", accountId: "" };
  // The old check was `(record.accountId || accountId) === accountId`, which
  // made an unowned row belong to whichever business was doing the looking.
  assert.equal(recordBelongsToAccountStrict(orphan, BUSINESS_A), false);
  assert.equal(recordBelongsToAccountStrict(orphan, BUSINESS_B), false);
  assert.equal(calendarItemBelongsToAccount(orphan, BUSINESS_A), false);
  assert.equal(calendarItemBelongsToAccount({ id: "x" }, BUSINESS_A), false);
  assert.equal(calendarItemBelongsToAccount({ id: "y", accountId: BUSINESS_A }, BUSINESS_A), true);
});

test("a user with no account passes no membership check", () => {
  // `!user.accountId || user.accountId === accountId` used to let an app user
  // with no account through every check in the app.
  assert.equal(userBelongsToAccountStrict({ id: "u" }, BUSINESS_A), false);
  assert.equal(userBelongsToAccountStrict({ id: "u", accountId: "" }, BUSINESS_A), false);
  assert.equal(userBelongsToAccountStrict({ id: "u", accountId: BUSINESS_A }, BUSINESS_B), false);
  assert.equal(userBelongsToAccountStrict({ id: "u", accountId: BUSINESS_B }, BUSINESS_B), true);
});

// --- Test 4: people -------------------------------------------------------

test("the same client email in two businesses returns only the caller's row", async () => {
  const issued = fakeDatabase(() => [
    { id: "p-a", account_id: BUSINESS_A, name: "Player One", email: "player@example.com" },
    { id: "p-b", account_id: BUSINESS_B, name: "Player One", email: "player@example.com" },
  ]);
  try {
    await readPeople(BUSINESS_B);
    const read = issued.find((statement) => statement.text.includes("FROM people"));
    assert.ok(read, "people were read");
    assert.match(read!.text, /WHERE account_id = \$1/);
    assert.deepEqual(read!.values, [BUSINESS_B]);
  } finally {
    restoreDatabase();
  }
});

// --- Test 5: settings ------------------------------------------------------

test("settings are read for one business only", async () => {
  const issued = fakeDatabase(() => [
    { key: "accountBusinessName", value: "Business A" },
    { key: "accountBusinessName", value: "Business B" },
  ]);
  try {
    await readSettingsMap(BUSINESS_B);
    const read = issued.find((statement) => statement.text.includes("FROM settings"));
    assert.ok(read, "settings were read");
    assert.match(read!.text, /account_id = \$1/);
    assert.equal(read!.values[0], BUSINESS_B);
  } finally {
    restoreDatabase();
  }
});

test("a single settings key is read for one business only", async () => {
  const issued = fakeDatabase(() => [{ value: "Business B" }]);
  try {
    const value = await getSetting(BUSINESS_B, "accountBusinessName");
    assert.equal(value, "Business B");
    const read = issued.find((statement) => statement.text.includes("FROM settings"));
    assert.match(read!.text, /account_id = \$1 AND key = \$2/);
    assert.deepEqual(read!.values, [BUSINESS_B, "accountBusinessName"]);
  } finally {
    restoreDatabase();
  }
});

test("a settings read with no account returns nothing rather than everything", async () => {
  const issued = fakeDatabase(() => [{ key: "accountBusinessName", value: "Business A" }]);
  try {
    assert.deepEqual(await readSettingsMap(""), {});
    assert.equal(await getSetting("", "accountBusinessName"), "");
    assert.equal(issued.length, 0, "an unscoped settings read never reaches the database");
  } finally {
    restoreDatabase();
  }
});

test("a settings write refuses to run without a business", async () => {
  await assert.rejects(
    () => setSettingsBulk("", { accountBusinessName: "Business B" }, async () => ({ rows: [] })),
    /accountId is required/,
  );
});

// --- Test 6: a forged account id in the request body ------------------------

test("a calendar write is stamped with the server's account, not the item's", () => {
  // Business B saves a booking whose body claims it belongs to Business A.
  const forged = { id: "b-2", accountId: BUSINESS_A, kind: "appointment", week: 0, day: 1, start: 540, duration: 60, title: "Forged" };
  const params = calendarItemParams(forged, BUSINESS_B);
  assert.equal(params[0], "b-2");
  assert.equal(params[1], BUSINESS_B, "the account column comes from server context");
  assert.notEqual(params[1], BUSINESS_A);
});

test("a calendar write with no server account is refused outright", async () => {
  assert.throws(
    () => calendarItemParams({ id: "x", kind: "appointment" }, ""),
    (error: any) => error?.code === "account_scope_unavailable",
  );
  await assert.rejects(
    () => writeItems([{ id: "x", kind: "appointment", week: 0, day: 1, start: 540, duration: 60, title: "x" }], {}),
    (error: any) => error?.code === "account_scope_unavailable",
  );
});

test("replacing a calendar deletes only the caller's stale rows", async () => {
  const issued = fakeDatabase(() => []);
  try {
    await writeItems(
      [{ id: "b-1", kind: "appointment", week: 0, day: 1, start: 540, duration: 60, title: "Keep" }],
      { accountId: BUSINESS_B, replaceItems: true },
    );
    const cleanup = issued.find((statement) => statement.text.startsWith("DELETE FROM calendar_items"));
    assert.ok(cleanup, "stale rows were cleaned up");
    // Scoped in the statement. The old path read every row in the table, worked
    // out which were stale in JavaScript, and deleted by id list.
    assert.match(cleanup!.text, /WHERE account_id = \$1 AND NOT \(id = ANY\(\$2::text\[\]\)\)/);
    assert.equal(cleanup!.values[0], BUSINESS_B);
    assert.ok(!issued.some((statement) => statement.text === "SELECT id FROM calendar_items"));
  } finally {
    restoreDatabase();
  }
});

test("clearing a calendar cannot clear the whole table", async () => {
  const issued = fakeDatabase(() => []);
  try {
    await writeItems([], { accountId: BUSINESS_B, clearItems: true });
    const cleared = issued.find((statement) => statement.text.startsWith("DELETE FROM calendar_items"));
    assert.equal(cleared?.text, "DELETE FROM calendar_items WHERE account_id = $1");
    assert.deepEqual(cleared?.values, [BUSINESS_B]);
  } finally {
    restoreDatabase();
  }
});

// --- Test 7: a cross-account object id --------------------------------------

test("knowing another business's booking id is not enough to read it", async () => {
  const issued = fakeDatabase(() => []);
  try {
    const item = await readCalendarItemById(BUSINESS_B, "a-1");
    assert.equal(item, null);
    const read = issued.find((statement) => statement.text.includes("FROM calendar_items"));
    assert.match(read!.text, /WHERE ci\.id = \$1 AND ci\.account_id = \$2/);
    assert.deepEqual(read!.values, ["a-1", BUSINESS_B]);
  } finally {
    restoreDatabase();
  }
});

test("the public appointment lookups cannot be built without a business", () => {
  assert.throws(
    () => publicAppointmentReadQuery({ appointmentId: "a-1", accountId: "" }),
    (error: any) => error?.code === "account_scope_unavailable",
  );
  assert.throws(
    () => publicAppointmentContactQuery({ accountId: "", email: "player@example.com" }),
    (error: any) => error?.code === "account_scope_unavailable",
  );
  assert.throws(
    () => publicSlotCalendarItemsQuery({ accountId: "", week: 0 }),
    (error: any) => error?.code === "account_scope_unavailable",
  );
});

test("the public appointment lookup pins both the id and the business", () => {
  const query = publicAppointmentReadQuery({ appointmentId: "a-1", accountId: BUSINESS_B });
  assert.match(query, /(?:^|&)id=eq\.a-1(?:&|$)/);
  assert.match(query, new RegExp(`(?:^|&)account_id=eq\\.${BUSINESS_B}(?:&|$)`));
});

// --- Test 8: the public business slug ---------------------------------------

test("an unknown public slug resolves to nothing, never to the original business", async () => {
  const issued = fakeDatabase(() => []);
  try {
    assert.equal(await resolvePublicAccount("no-such-business"), null);
    const read = issued.find((statement) => statement.text.includes("FROM accounts"));
    assert.ok(read, "the slug was checked against the accounts table");
    assert.deepEqual(read!.values, ["no-such-business", "no-such-business"]);
  } finally {
    restoreDatabase();
  }
});

test("an empty public slug is refused without a lookup", async () => {
  const issued = fakeDatabase(() => [{ id: BUSINESS_A, slug: BUSINESS_A, business_name: "A", status: "active" }]);
  try {
    assert.equal(await resolvePublicAccount(""), null);
    assert.equal(issued.length, 0, "an empty slug never reaches the database");
  } finally {
    restoreDatabase();
  }
});

test("a known public slug resolves to that business and only that business", async () => {
  fakeDatabase((text, values) => {
    if (!text.includes("FROM accounts")) return [];
    return values[0] === BUSINESS_B
      ? [{ id: BUSINESS_B, slug: BUSINESS_B, business_name: "Boundary Test Business", status: "active" }]
      : [];
  });
  try {
    const account = await resolvePublicAccount(BUSINESS_B);
    assert.equal(account?.id, BUSINESS_B);
    assert.equal(account?.businessName, "Boundary Test Business");
    assert.equal(await resolvePublicAccount(BUSINESS_A), null);
  } finally {
    restoreDatabase();
  }
});

// --- The first login of a new business --------------------------------------
//
// The manual acceptance check says a new business's first login must contain
// none of "Sam Hale", "Sam Hale Golf", the original venue, or that business's
// lesson list and invoice footer. These pin that down without a browser.

test("a new business inherits none of the original coach's details", () => {
  // No settings rows yet: this is exactly the state a freshly provisioned
  // business is in, and where the old defaults leaked through.
  const account = coachAccountFromSettings({ accountId: BUSINESS_B }, BUSINESS_B);
  const serialised = JSON.stringify(account);

  assert.equal(account.id, BUSINESS_B);
  assert.equal(account.coachName, "");
  assert.equal(account.businessName, "");
  assert.equal(account.venueName, "");
  assert.equal(account.contactEmail, "");
  for (const leak of ["Sam Hale", "Sam Hale Golf", "The Range 24/7", "Three Kings"]) {
    assert.ok(!serialised.includes(leak), `a new business must not carry "${leak}"`);
  }
});

test("a new business starts with no lesson types of its own and no bookable hours", () => {
  const services = servicesFromSettings({ accountId: BUSINESS_B }, BUSINESS_B);
  // The one entry is the reserved "external-booking" type, which every
  // workspace needs so an imported booking has a lesson type to reference. It
  // is product-level, and it is filed under this business, not the original.
  assert.deepEqual(services.map((service: any) => service.id), ["external-booking"]);
  assert.equal(services[0].accountId, BUSINESS_B);
  // None of the original coach's lesson types came along.
  assert.equal(services.some((service: any) => /lesson-30|lesson-60/.test(service.id)), false);

  const availability = availabilityFromSettings({ accountId: BUSINESS_B }, BUSINESS_B);
  assert.equal(availability.length, 7);
  assert.deepEqual(availability.flat(), [], "a new business is closed until it says otherwise");
});

test("the original workspace keeps every one of its own defaults", () => {
  // The other half of the rule: nothing about the existing business changes.
  const account = coachAccountFromSettings({ accountId: BUSINESS_A }, BUSINESS_A);
  assert.ok(account.businessName, "the original business still has a name");
  assert.ok(account.venueName, "the original business still has a venue");
  const originalServices = servicesFromSettings({ accountId: BUSINESS_A }, BUSINESS_A);
  assert.ok(originalServices.some((service: any) => service.id === "lesson-60"), "its own lesson types are still seeded");
  assert.ok(availabilityFromSettings({ accountId: BUSINESS_A }, BUSINESS_A).flat().length > 0);
});

test("a new business's invoices carry no reference to the original one", () => {
  const account = coachAccountFromSettings({ accountId: BUSINESS_B }, BUSINESS_B);
  assert.equal(account.invoiceSettings.footerText, "");
  assert.equal(account.invoiceSettings.defaultCustomerNote, "");
  // Product-level invoice mechanics are still there: this is a neutral start,
  // not a broken one.
  assert.equal(account.invoiceSettings.prefix, "INV");
  assert.equal(account.invoiceSettings.enabled, true);
});
