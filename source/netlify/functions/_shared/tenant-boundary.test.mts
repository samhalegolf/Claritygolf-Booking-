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
  appUserRoleForMembership,
  recordBelongsToAccountStrict,
  requireCoachActor,
  resolvePublicAccount,
  sessionRoleForMembership,
  switchActiveAccount,
  userBelongsToAccountStrict,
} from "./coach-auth.mts";
import { requireSandboxAccount, sandboxAccountIdFor } from "./sandbox.mts";
import { canonicalPhoneKey, formatPhoneForDisplay } from "./phone.mts";
import { bayBookingMatchesSlot, wallClockToUnixSeconds, datePartsForSlot } from "./optix-reconcile.mts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currencyForCountry, localeForCountry } from "./locale.mts";
import * as phoneModule from "./phone.mts";
import * as localeModule from "./locale.mts";
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
  handleBookingApiRoute,
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
    // Slug, id, and the kind filter. A sandbox resolves only when it is named:
    // it is the coach's test tenant and needs a booking page of its own.
    assert.deepEqual(read!.values, ["no-such-business", "no-such-business", "live", "sandbox"]);
    assert.match(read!.text, /kind IN \(\$3, \$4\)/, "the lookup is pinned to live and sandbox accounts");
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

// --- The login response's role vocabulary -----------------------------------
//
// Three vocabularies meet here and are not interchangeable: the membership role
// (owner/admin/coach), the session role the app shell routes on
// (guest/coach/player), and the app-user role permissions are read from
// (account_admin/coach/staff). Sending a membership role where a session role
// was expected made a *successful* login sit on the sign-in screen with no
// error at all -- 200, authenticated: true, and the client read "owner" as a
// guest. These pin the translation.

test("an owner signs in as a coach session, not as their membership role", () => {
  // "owner" is not a value the app shell knows; it would fall through to guest.
  assert.equal(sessionRoleForMembership("owner"), "coach");
  assert.equal(sessionRoleForMembership("admin"), "coach");
  assert.equal(sessionRoleForMembership("coach"), "coach");
});

test("the session role is always one the client can route on", () => {
  const routable = new Set(["guest", "coach", "player"]);
  for (const role of ["owner", "admin", "coach"] as const) {
    assert.ok(
      routable.has(sessionRoleForMembership(role)),
      `${role} must map into the session vocabulary`,
    );
  }
});

test("an owner gets admin permissions in the app, under a role the app knows", () => {
  // cleanAppUser only accepts account_admin | coach | staff | platform_admin |
  // admin. "owner" would be discarded and the user silently demoted.
  const known = new Set(["account_admin", "coach", "staff", "platform_admin", "admin"]);
  assert.equal(appUserRoleForMembership("owner"), "account_admin");
  assert.equal(appUserRoleForMembership("admin"), "account_admin");
  assert.equal(appUserRoleForMembership("coach"), "coach");
  for (const role of ["owner", "admin", "coach"] as const) {
    assert.ok(known.has(appUserRoleForMembership(role)), `${role} must map into the app-user vocabulary`);
  }
});

// --- No other business's identity in the email/notification path -------------
//
// The database was provably clean and a second business still saw "The Range
// 24/7 - Three Kings" as its venue and booking emails signed "Sam Hale". The
// leak was never in the data: it was a dozen `x || "<the original's value>"`
// fallbacks in the code, on both sides. These assert the source itself, which
// is the only place that class of bug lives.

test("no source file falls back to the original business's identity", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const path = await import("node:path");

  // Strings that name the original business, its owner or its venue.
  const identity = [/Sam Hale/, /The Range 24\/7/, /Three Kings/, /Range 24\/7 Member/];

  // Where these literals are legitimate: the one-time seed of the original
  // workspace, and the env-backed defaults guarded by isOriginalWorkspace /
  // envIfOriginal / orDefault. Everything else must be neutral.
  const allowed = [
    /legacyOriginalWorkspaceId\(\)/,
    /envIfOriginal\(/,
    /orDefault\(/,
    /^\s*(\/\/|\*|--)/,       // comments explaining the history
    /defaultCoachAccount\(\)/,  // guarded by isOriginalWorkspace at its callers
    /CLARITY_(COACH|BUSINESS|VENUE)/, // env-backed, original-workspace only
    /'Sam Hale Golf', 'active'/,      // the accounts seed for the original
    /name: "30min Golf Lesson \(Range 24\/7 Member\)"/, // seeded demo catalogue
    /name: "1 Hour Golf Lesson \(Range 24\/7 Member\)"/,
    /location: "Range 24\/7 member bay"/,
    /id: "member-(30|60)"/,
    /range-three-kings/,          // known outstanding: booking-screen paths
    /Range Three Kings/,
    /footerText: "Thank you for training with Sam Hale Golf\."/, // blanked by neutralInvoiceSettings
  ];

  const roots = ["netlify/functions", "src"];
  const offenders: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry === "node_modules" || entry.endsWith(".test.mts") || entry.endsWith(".test.ts")) continue;
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(mts|ts|tsx|mjs)$/.test(entry)) continue;
      readFileSync(full, "utf8").split("\n").forEach((line, index) => {
        if (!identity.some((pattern) => pattern.test(line))) return;
        if (allowed.some((pattern) => pattern.test(line))) return;
        offenders.push(`${full}:${index + 1}  ${line.trim().slice(0, 120)}`);
      });
    }
  }
  roots.forEach(walk);

  assert.deepEqual(
    offenders,
    [],
    `these lines put the original business's identity where any workspace could read it:\n${offenders.join("\n")}`,
  );
});


// --- The sandbox boundary ---------------------------------------------------
//
// A sandbox is another business, so every test above already applies to it. What
// these pin down is the part that is new: a sandbox has no membership row, so
// the right to act for one is derived from the membership on the business it
// belongs to -- and a live account can never satisfy a sandbox-only check,
// because satisfying one means having a row that a live account does not have.

const SANDBOX_B = sandboxAccountIdFor(BUSINESS_B);
const SANDBOX_AUTH_USER = "33333333-3333-3333-3333-333333333333";

/**
 * A session switched to `activeAccountId`, whose owner holds `memberships`, and
 * a database that knows about `sandboxes` ({ id -> parent business }).
 */
function sandboxFixture(options: {
  activeAccountId?: string;
  memberships?: { id: string; account_id: string; role: string; coach_id?: string }[];
  sandboxes?: Record<string, string>;
}) {
  const memberships = options.memberships ?? [
    { id: "m-b", account_id: BUSINESS_B, role: "coach", coach_id: "coach-b" },
  ];
  const sandboxes = options.sandboxes ?? { [SANDBOX_B]: BUSINESS_B };
  return fakeDatabase((text, values) => {
    if (text.includes("FROM admin_sessions")) {
      return [
        {
          auth_user_id: SANDBOX_AUTH_USER,
          user_id: "admin-3",
          email: "coach@business-b.test",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          active_account_id: options.activeAccountId ?? null,
        },
      ];
    }
    if (text.includes("FROM account_memberships")) return memberships;
    if (text.includes("FROM accounts")) {
      const wanted = String(values[0] ?? "");
      const parent = sandboxes[wanted];
      return parent
        ? [
            {
              id: wanted,
              slug: wanted,
              business_name: "Sandbox",
              status: "active",
              sandbox_of_account_id: parent,
            },
          ]
        : [];
    }
    return [];
  });
}

test("a session switched to the sandbox acts for the sandbox, not the live business", async () => {
  sandboxFixture({ activeAccountId: SANDBOX_B });
  try {
    const actor = await requireCoachActor(sessionRequest());
    assert.equal(actor.accountId, SANDBOX_B);
    assert.equal(actor.sandboxOfAccountId, BUSINESS_B);
    // The role is inherited rather than flattened to owner: a coach is a coach
    // in the sandbox too, which is what makes permission behaviour testable.
    assert.equal(actor.role, "coach");
    assert.equal(actor.isOwner, false);
  } finally {
    restoreDatabase();
  }
});

test("a live session is never marked as a sandbox one", async () => {
  sandboxFixture({ activeAccountId: BUSINESS_B });
  try {
    const actor = await requireCoachActor(sessionRequest());
    assert.equal(actor.accountId, BUSINESS_B);
    assert.equal(actor.sandboxOfAccountId, undefined);
  } finally {
    restoreDatabase();
  }
});

test("a sandbox belonging to another business is not reachable", async () => {
  // The session names business A's sandbox; this user only belongs to B.
  const otherSandbox = sandboxAccountIdFor(BUSINESS_A);
  sandboxFixture({
    activeAccountId: otherSandbox,
    sandboxes: { [otherSandbox]: BUSINESS_A },
  });
  try {
    const actor = await requireCoachActor(sessionRequest());
    // Falls back to their own business rather than locking them out -- and
    // emphatically not into someone else's sandbox.
    assert.equal(actor.accountId, BUSINESS_B);
    assert.equal(actor.sandboxOfAccountId, undefined);
  } finally {
    restoreDatabase();
  }
});

test("losing the live membership loses the sandbox with it, in the same instant", async () => {
  // No membership row at all: the coach was removed from the business. There is
  // no sandbox membership left behind to keep working, because there never was
  // one -- which is the whole reason access is derived rather than mirrored.
  sandboxFixture({ activeAccountId: SANDBOX_B, memberships: [] });
  try {
    await assert.rejects(
      () => requireCoachActor(sessionRequest()),
      (error: any) => error?.status === 403 && error?.code === "membership_required",
    );
  } finally {
    restoreDatabase();
  }
});

test("switching to an account the user has no claim on writes nothing", async () => {
  const issued = sandboxFixture({});
  try {
    await assert.rejects(
      () => switchActiveAccount(sessionRequest(), BUSINESS_A),
      (error: any) => error?.status === 403 && error?.code === "membership_required",
    );
    assert.ok(
      !issued.some((statement) => statement.text.includes("UPDATE admin_sessions")),
      "a refused switch leaves the session's active account alone",
    );
  } finally {
    restoreDatabase();
  }
});

test("switching to this business's sandbox is allowed and is recorded", async () => {
  const issued = sandboxFixture({});
  try {
    const actor = await switchActiveAccount(sessionRequest(), SANDBOX_B);
    assert.equal(actor.accountId, SANDBOX_B);
    const write = issued.find((statement) => statement.text.includes("UPDATE admin_sessions"));
    assert.ok(write, "the switch is persisted on the session");
    assert.equal(write!.values[0], SANDBOX_B);
  } finally {
    restoreDatabase();
  }
});

test("a sandbox-only capability refuses a live account", async () => {
  // requireSandboxAccount is the gate every sandbox-only route opens with. A
  // live business has no sandbox row, so there is nothing for it to match --
  // not a check that could be skipped, an absence that cannot be satisfied.
  sandboxFixture({});
  try {
    await assert.rejects(
      () => requireSandboxAccount(BUSINESS_B),
      (error: any) => error?.status === 403 && error?.code === "sandbox_required",
    );
    const sandbox = await requireSandboxAccount(SANDBOX_B);
    assert.equal(sandbox.sandboxOfAccountId, BUSINESS_B);
  } finally {
    restoreDatabase();
  }
});

// --- The sandbox player handoff ---------------------------------------------
//
// "Continue as this player" is the one capability in the app that lets one
// person act as another, so it gets the most direct tests here: the route
// itself, not the helpers underneath it.

function coachRequest(path: string, body: unknown = {}, cookie = "clarity_session=session-token") {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a coach in the live workspace cannot impersonate anybody", async () => {
  // The live business is not a sandbox, so readSandboxAccount finds nothing and
  // there is nothing this account could present that would change that. The
  // refusal is an absence in the accounts table, not a policy check.
  sandboxFixture({ activeAccountId: BUSINESS_B, sandboxes: {} });
  try {
    const response = await handleBookingApiRoute(
      coachRequest("/api/sandbox/impersonate", { personId: "person-1" }),
      "/api/sandbox/impersonate",
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "sandbox_required");
  } finally {
    restoreDatabase();
  }
});

test("impersonation refuses even when the live account names its own sandbox", async () => {
  // The sandbox exists and belongs to this business -- but the session is not in
  // it, and the account being checked is the one the membership resolved to. An
  // id in a request body is never what decides.
  sandboxFixture({ activeAccountId: BUSINESS_B });
  try {
    const response = await handleBookingApiRoute(
      coachRequest("/api/sandbox/impersonate", { personId: "person-1", accountId: SANDBOX_B }),
      "/api/sandbox/impersonate",
    );
    assert.equal(response.status, 403);
  } finally {
    restoreDatabase();
  }
});

test("returning to coach refuses a session that is not a handoff", async () => {
  // A real player's session must not be endable through this route: it is the
  // way back from an impersonation, not a way to sign somebody out.
  fakeDatabase((text) => {
    if (text.includes("FROM player_sessions")) {
      return [
        {
          person_id: "person-1",
          email: "player@business-b.test",
          account_id: BUSINESS_B,
          portal_player_id: null,
          sandbox_actor_auth_user: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ];
    }
    return [];
  });
  try {
    const response = await handleBookingApiRoute(
      coachRequest("/api/sandbox/return", {}, "clarity_player_session=player-token"),
      "/api/sandbox/return",
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "not_impersonating");
  } finally {
    restoreDatabase();
  }
});

test("an ordinary player session alongside a coach cookie still reads as the coach", async () => {
  // A coach who is also a player on their own browser holds both cookies. Only
  // a handoff may outrank the coach session -- otherwise signing in as a coach
  // would land in the portal.
  fakeDatabase((text) => {
    if (text.includes("FROM player_sessions")) {
      return [
        {
          person_id: "person-1",
          email: "both@business-b.test",
          account_id: BUSINESS_B,
          portal_player_id: null,
          sandbox_actor_auth_user: null,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ];
    }
    if (text.includes("FROM admin_sessions")) {
      return [
        {
          id: "admin-4",
          auth_user_id: SANDBOX_AUTH_USER,
          user_id: "admin-4",
          email: "both@business-b.test",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          active_account_id: null,
        },
      ];
    }
    if (text.includes("FROM account_memberships")) {
      return [{ id: "m-b", account_id: BUSINESS_B, role: "owner", coach_id: "coach-b" }];
    }
    return [];
  });
  try {
    const response = await handleBookingApiRoute(
      new Request("https://example.test/api/auth/session", {
        headers: { cookie: "clarity_session=session-token; clarity_player_session=player-token" },
      }),
      "/api/auth/session",
    );
    const body = await response.json();
    assert.equal(body.role, "coach");
    assert.equal(body.accountKind, "live");
  } finally {
    restoreDatabase();
  }
});

// --- No ambient country -----------------------------------------------------
//
// phone.mts held a module-level `activeCountry`, set by whichever code path
// last read an account's settings and defaulted into by every phone and date
// helper in the app. A Netlify instance stays warm and serves many businesses,
// so the value the previous request set was still there for the next one: a
// request that formatted a number or a date without first re-reading settings
// used the last business's country. Nothing noticed, because the answer was
// always plausible -- and "07/08" is 7 August to a NZ coach and 8 July to a US
// one, so the wrong one is a missed lesson rather than a visible error.
//
// The rule now is that there is nowhere for a country to go stale.

test("no module holds an active country for a request to inherit", () => {
  // Named exports rather than a grep, so this fails the moment one comes back.
  for (const name of ["setActivePhoneCountry", "getActivePhoneCountry"]) {
    assert.equal(
      (phoneModule as Record<string, unknown>)[name],
      undefined,
      `phone.mts exports ${name} again -- a warm instance can carry one business's country into the next`,
    );
  }
  for (const name of ["activeLocale", "activeCurrency"]) {
    assert.equal(
      (localeModule as Record<string, unknown>)[name],
      undefined,
      `locale.mts exports ${name} again -- it can only answer by reading an ambient country`,
    );
  }
});

test("two businesses formatting at once cannot see each other's country", () => {
  // Order-independent by construction: each call carries its own country, so
  // interleaving them changes nothing. Under the old module value, whichever
  // ran second decided for both.
  const nzThenUs = [
    formatPhoneForDisplay("0274637700", "NZ"),
    formatPhoneForDisplay("2125550123", "US"),
  ];
  const usThenNz = [
    formatPhoneForDisplay("2125550123", "US"),
    formatPhoneForDisplay("0274637700", "NZ"),
  ];
  assert.deepEqual(nzThenUs, [usThenNz[1], usThenNz[0]]);

  assert.equal(localeForCountry("NZ"), "en-NZ");
  assert.equal(localeForCountry("US"), "en-US");
  assert.equal(currencyForCountry("NZ"), "NZD");
  assert.equal(currencyForCountry("US"), "USD");
});

test("the same number in two countries is two different people", () => {
  // The reason the country cannot be approximate. "0274637700" is a real mobile
  // in New Zealand and something else entirely read as American, so a stale
  // country does not merely format oddly -- it decides whether contact matching
  // thinks two rows are one person.
  assert.notEqual(canonicalPhoneKey("0274637700", "NZ"), canonicalPhoneKey("0274637700", "US"));
  assert.equal(canonicalPhoneKey("+64274637700", "US"), canonicalPhoneKey("0274637700", "NZ"));
});

test("an unreadable country falls back to the deployment default, never to a neighbour", () => {
  // The fallback is a constant. It is emphatically not "whatever was set last",
  // which is what the module value amounted to.
  assert.equal(localeForCountry(""), "en-NZ");
  assert.equal(localeForCountry(undefined), "en-NZ");
  assert.equal(localeForCountry("not-a-country"), "en-NZ");
});

// --- No ambient timezone ----------------------------------------------------
//
// The country's twin, and the more dangerous of the two. `activeTimeZone` in
// booking-core.mts was set from whichever account was read last and reached
// through accountTimeZone() in a dozen places -- five of them slot maths. A
// stale country formats a date oddly; a stale timezone decides whether a lesson
// has already happened, which is the difference between a reminder sending and
// not, and between a slot being offered to the public and not.

const FUNCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceOf(name: string) {
  return readFileSync(join(FUNCTIONS_DIR, name), "utf8");
}

test("no module holds an active timezone for a request to inherit", () => {
  const source = sourceOf("booking-core.mts");
  // Comments explain why it is gone, so look for the declaration itself.
  assert.ok(
    !/^\s*let\s+activeTimeZone\b/m.test(source),
    "booking-core declares activeTimeZone again -- a warm instance will carry one business's clock into the next",
  );
  assert.ok(
    !/^\s*function\s+(accountTimeZone|setActiveTimeZone)\s*\(/m.test(source),
    "booking-core defines an ambient timezone accessor again",
  );
});

test("no shared module guesses a country's clock", () => {
  // bayBookingMatchesSlot defaulted to "Pacific/Auckland" when an appointment
  // carried no location timezone, so a coach in Europe had their bay compared
  // against Auckland's clock and a booked bay read as unbooked.
  const source = sourceOf("_shared/optix-reconcile.mts");
  assert.ok(
    !/defaultTimeZone\s*=\s*["']/.test(source),
    "optix-reconcile has a hardcoded default timezone again",
  );
});

test("the timezone argument is what decides, not the process", () => {
  // One slot, one stored bay timestamp, two timezones. If the argument were
  // ignored -- or came from somewhere other than this call -- these would agree.
  const slot = { week: 8, day: 2, start: 14 * 60, location: null };
  const aucklandStamp = wallClockToUnixSeconds({
    ...datePartsForSlot(slot.week, slot.day),
    minutes: slot.start,
    timeZone: "Pacific/Auckland",
  });

  assert.equal(bayBookingMatchesSlot(slot, aucklandStamp, "Pacific/Auckland"), true);
  assert.equal(bayBookingMatchesSlot(slot, aucklandStamp, "America/Phoenix"), false);

  // And the appointment's own location still wins over the fallback, so a
  // business with per-location timezones is unaffected by the default.
  const atLocation = { ...slot, location: { timezone: "Pacific/Auckland" } };
  assert.equal(bayBookingMatchesSlot(atLocation, aucklandStamp, "America/Phoenix"), true);
});
