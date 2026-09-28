import assert from "node:assert/strict";
import test from "node:test";

import { cleanScopes, hashApiKey, looksLikeApiKey, mintApiKey } from "./keys.mts";
import { decodeCursor, encodeCursor, listPage, pageLimit, requestHash } from "./http.mts";
import { cleanEventList, collapseChanges, eventTypeFor, isPrivateAddress, nextAttemptAt, objectIdFor, RETRY_SCHEDULE_MINUTES } from "./events.mts";
import { billingLines, dateOnly, invoiceObject } from "./commerce.mts";
import { bookingFromRow, previousAttributes, slotKey, isoToSlotKey, type Catalog } from "./serialize.mts";
import { ROUTES, matchRoute } from "./routes.mts";
import { openApiSpec } from "./openapi.mts";
import { verifyResourceWebhookSignature, signResourceWebhook } from "../resource-webhook.mts";

test("a key says which world it is from, and only its hash is kept", () => {
  const live = mintApiKey("live");
  const sandbox = mintApiKey("test");
  assert.match(live.key, /^ck_live_[A-Za-z0-9_-]{32}$/);
  assert.match(sandbox.key, /^ck_test_[A-Za-z0-9_-]{32}$/);
  assert.equal(looksLikeApiKey(live.key), true);
  assert.equal(live.hash, hashApiKey(live.key));
  assert.notEqual(live.hash, live.key);
  assert.equal(live.hint, `ck_live_…${live.key.slice(-4)}`);
  assert.notEqual(mintApiKey("live").key, live.key);
  for (const bad of ["", "ck_live_short", "sk_live_" + "a".repeat(32), `Bearer ${live.key}`]) {
    assert.equal(looksLikeApiKey(bad), false, bad);
  }
});

test("scopes are whatever is recognised, in a fixed order", () => {
  assert.deepEqual(cleanScopes(["clients:read", "nonsense", "bookings:read"]), ["bookings:read", "clients:read"]);
  assert.deepEqual(cleanScopes("bookings:read"), []);
});

test("a cursor round-trips, and a forged one is refused", () => {
  const url = new URL(`https://x.test/api/v1/bookings?cursor=${encodeCursor([123, "appt-1"])}`);
  assert.deepEqual(decodeCursor(url), [123, "appt-1"]);
  assert.throws(() => decodeCursor(new URL("https://x.test/?cursor=nope")), /cursor/);
  assert.equal(decodeCursor(new URL("https://x.test/")), null);
});

test("limit is 1-100", () => {
  assert.equal(pageLimit(new URL("https://x.test/")), 25);
  assert.equal(pageLimit(new URL("https://x.test/?limit=100")), 100);
  assert.throws(() => pageLimit(new URL("https://x.test/?limit=0")));
  assert.throws(() => pageLimit(new URL("https://x.test/?limit=101")));
  assert.throws(() => pageLimit(new URL("https://x.test/?limit=2.5")));
});

test("a page knows whether there is another", () => {
  const rows = [1, 2, 3];
  assert.deepEqual(listPage(rows, 2, (row) => [row], (row) => row), {
    object: "list",
    data: [1, 2],
    has_more: true,
    next_cursor: encodeCursor([2]),
  });
  assert.equal(listPage(rows, 3, (row) => [row], (row) => row).has_more, false);
  assert.equal(listPage(rows, 3, (row) => [row], (row) => row).next_cursor, null);
});

test("an idempotency key is bound to the exact request", () => {
  assert.equal(requestHash("POST", "/api/v1/bookings", "{}"), requestHash("POST", "/api/v1/bookings", "{}"));
  assert.notEqual(requestHash("POST", "/api/v1/bookings", "{}"), requestHash("POST", "/api/v1/bookings", '{"a":1}'));
});

// ---------------------------------------------------------------------------

const row = (over: Record<string, unknown> = {}) => ({
  id: "appt-1",
  account_id: "biz",
  kind: "appointment",
  week: 17,
  day: 0,
  start: 600,
  duration: 60,
  status: "booked",
  ...over,
});

test("changes to one row within a batch collapse to where it started and ended", () => {
  const changes = collapseChanges([
    { id: 1, account_id: "biz", table_name: "calendar_items", op: "INSERT", row_id: "appt-1", old_row: null, new_row: row(), changed_at: "t1" },
    { id: 2, account_id: "biz", table_name: "calendar_items", op: "UPDATE", row_id: "appt-1", old_row: row(), new_row: row({ person_id: "p1" }), changed_at: "t2" },
    { id: 3, account_id: "biz", table_name: "people", op: "INSERT", row_id: "p1", old_row: null, new_row: { id: "p1" }, changed_at: "t2" },
  ]);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].before, null);
  assert.equal(changes[0].after.person_id, "p1");
  assert.equal(changes[0].at, "t2");
  assert.equal(eventTypeFor(changes[0]), "booking.created");
  assert.equal(eventTypeFor(changes[1]), "client.created");
});

test("a change that means something is never folded into the one before it", () => {
  const changes = collapseChanges([
    { id: 1, account_id: "biz", table_name: "calendar_items", op: "INSERT", row_id: "appt-1", old_row: null, new_row: row(), changed_at: "t1" },
    { id: 2, account_id: "biz", table_name: "calendar_items", op: "UPDATE", row_id: "appt-1", old_row: row(), new_row: row({ start: 660 }), changed_at: "t2" },
    { id: 3, account_id: "biz", table_name: "calendar_items", op: "UPDATE", row_id: "appt-1", old_row: row({ start: 660 }), new_row: row({ start: 660, resource_id: "bay-2" }), changed_at: "t3" },
    { id: 4, account_id: "biz", table_name: "calendar_items", op: "UPDATE", row_id: "appt-1", old_row: row({ start: 660, resource_id: "bay-2" }), new_row: row({ start: 660, resource_id: "bay-2", status: "cancelled" }), changed_at: "t4" },
  ]);
  assert.deepEqual(changes.map(eventTypeFor), ["booking.created", "booking.rescheduled", "booking.cancelled"]);
  assert.equal(changes[1].after.resource_id, "bay-2", "the bay assignment folded into the move");
});

test("each kind of booking change is its own event", () => {
  const t = "calendar_items";
  assert.equal(eventTypeFor({ table: t, before: null, after: row() }), "booking.created");
  assert.equal(eventTypeFor({ table: t, before: row(), after: null }), "booking.cancelled");
  assert.equal(eventTypeFor({ table: t, before: row(), after: row({ status: "cancelled" }) }), "booking.cancelled");
  assert.equal(eventTypeFor({ table: t, before: row(), after: row({ status: "completed" }) }), "booking.completed");
  assert.equal(eventTypeFor({ table: t, before: row(), after: row({ status: "no_show" }) }), "booking.no_show");
  assert.equal(eventTypeFor({ table: t, before: row(), after: row({ start: 660 }) }), "booking.rescheduled");
  assert.equal(eventTypeFor({ table: t, before: row(), after: row({ duration: 90 }) }), "booking.rescheduled");
  assert.equal(eventTypeFor({ table: t, before: row(), after: row({ note: "bring clubs" }) }), "booking.updated");
  assert.equal(eventTypeFor({ table: t, before: null, after: null }), null);
  assert.equal(eventTypeFor({ table: "people", before: { id: "p" }, after: { id: "p", name: "x" } }), "client.updated");
  assert.equal(eventTypeFor({ table: "people", before: { id: "p" }, after: null }), "client.deleted");
});

test("retries back off, then stop", () => {
  const now = 1_000_000;
  assert.equal(nextAttemptAt(1, now)?.getTime(), now + 60_000);
  assert.equal(nextAttemptAt(2, now)?.getTime(), now + 5 * 60_000);
  assert.equal(nextAttemptAt(RETRY_SCHEDULE_MINUTES.length + 1, now), null);
});

test("an endpoint's event list is known types, or everything", () => {
  assert.deepEqual(cleanEventList(undefined), ["*"]);
  assert.deepEqual(cleanEventList(["booking.created", "*"]), ["*"]);
  assert.deepEqual(cleanEventList(["client.created", "bogus", "booking.created"]), ["booking.created", "client.created"]);
});

test("webhooks never go to a private address, whatever name points at it", () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("a delivery signature verifies with the endpoint secret, like Stripe's", () => {
  const body = JSON.stringify({ id: "evt_1", type: "booking.created" });
  const now = 1_790_000_000;
  const header = signResourceWebhook("whsec_x", body, now);
  assert.equal(verifyResourceWebhookSignature("whsec_x", body, header, now), true);
  assert.equal(verifyResourceWebhookSignature("whsec_y", body, header, now), false);
});

// ---------------------------------------------------------------------------

const catalog: Catalog = {
  accountId: "biz",
  name: "Biz",
  timezone: "Pacific/Auckland",
  currency: "nzd",
  country: "NZ",
  livemode: true,
  services: [{ id: "lesson-60", name: "60 min lesson", locationIds: ["range"] }],
  coaches: [{ id: "coach-sam", displayName: "Sam" }],
  locations: [{ id: "range", name: "Main Range", timezone: "Pacific/Auckland" }],
};

test("a booking row reads as a booking with real times in its location's zone", () => {
  // Week 17 day 0 is Monday 28 September 2026; NZDT (+13:00) began the day before.
  const booking = bookingFromRow(
    row({ service_id: "lesson-60", coach_id: "coach-sam", client: "Alex Player", email: "a@x.test", person_id: "p1" }),
    catalog,
  );
  assert.equal(booking.object, "booking");
  assert.equal(booking.start, "2026-09-28T10:00:00+13:00");
  assert.equal(booking.end, "2026-09-28T11:00:00+13:00");
  assert.equal(booking.timezone, "Pacific/Auckland");
  assert.deepEqual(booking.service, { id: "lesson-60", name: "60 min lesson" });
  assert.deepEqual(booking.coach, { id: "coach-sam", name: "Sam" });
  assert.deepEqual(booking.location, { id: "range", name: "Main Range" });
  assert.deepEqual(booking.client, { id: "p1", name: "Alex Player", email: "a@x.test", phone: "" });
  assert.equal(bookingFromRow(row(), catalog, { deleted: true }).status, "cancelled");
});

test("a date filter lands on the same grid position the row has", () => {
  assert.equal(isoToSlotKey("2026-09-28T10:00:00+13:00", "Pacific/Auckland"), slotKey(17, 0, 600));
});

test("previous_attributes carries only what changed", () => {
  const before = bookingFromRow(row({ start: 600 }), catalog);
  const after = bookingFromRow(row({ start: 660 }), catalog);
  const previous = previousAttributes(before, after);
  assert.deepEqual(Object.keys(previous).sort(), ["end", "start"]);
  assert.equal(previous.start, "2026-09-28T10:00:00+13:00");
});

// ---------------------------------------------------------------------------

test("routes match by method and path, and a wrong method is told so", () => {
  const cancel = matchRoute("POST", "/bookings/appt-17/cancel");
  assert.ok(cancel && "route" in cancel);
  assert.deepEqual(cancel.params, ["appt-17"]);
  assert.equal(cancel.route.scope, "bookings:write");
  assert.deepEqual(matchRoute("PUT", "/bookings"), { methodNotAllowed: true });
  assert.equal(matchRoute("GET", "/nowhere"), null);
  const me = matchRoute("GET", "/me");
  assert.ok(me && "route" in me && me.route.scope === null);
});

test("every write needs a write scope, and nothing but /me and /event_types is unscoped", () => {
  for (const route of ROUTES) {
    if (route.method !== "GET") assert.match(String(route.scope), /:(write|manage)$/, route.path);
    if (!route.scope) assert.ok(["/me", "/event_types"].includes(route.path), route.path);
  }
});

test("the OpenAPI spec describes every route there is", () => {
  const spec = openApiSpec("https://clarity.test");
  const described = new Set<string>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods as object)) described.add(`${method.toUpperCase()} ${path}`);
  }
  for (const route of ROUTES) {
    const path = route.path.replace(/:id/g, "{id}");
    assert.ok(described.has(`${route.method} ${path}`), `${route.method} ${path} is not in the spec`);
  }
});

// ---------------------------------------------------------------------------
// Passes and invoices

test("pass changes are events about the pass, whichever table moved", () => {
  const pass = { id: "pass-1", status: "active" };
  assert.equal(eventTypeFor({ table: "passes", before: null, after: pass }), "pass.created");
  assert.equal(eventTypeFor({ table: "passes", before: pass, after: { ...pass, status: "void" } }), "pass.voided");
  assert.equal(eventTypeFor({ table: "passes", before: pass, after: { ...pass, note: "x" } }), "pass.updated");
  assert.equal(eventTypeFor({ table: "pass_allocations", before: null, after: { pass_id: "pass-1" } }), "pass.updated");
  const spend = { id: "red-1", pass_id: "pass-1", credits: 1 };
  assert.equal(eventTypeFor({ table: "pass_redemptions", before: null, after: spend }), "pass.redeemed");
  assert.equal(eventTypeFor({ table: "pass_redemptions", before: spend, after: { ...spend, reversed_at: "t" } }), "pass.updated");
  assert.equal(objectIdFor({ table: "pass_redemptions", rowId: "red-1", before: null, after: spend }), "pass-1");
  assert.equal(objectIdFor({ table: "passes", rowId: "pass-1", before: null, after: pass }), "pass-1");
});

test("invoice status changes are their own events", () => {
  const invoice = { id: "inv-1", status: "draft" };
  const t = "billing_invoices";
  assert.equal(eventTypeFor({ table: t, before: null, after: invoice }), "invoice.created");
  assert.equal(eventTypeFor({ table: t, before: invoice, after: { ...invoice, status: "sent" } }), "invoice.sent");
  assert.equal(eventTypeFor({ table: t, before: { ...invoice, status: "sent" }, after: { ...invoice, status: "paid" } }), "invoice.paid");
  assert.equal(eventTypeFor({ table: t, before: invoice, after: { ...invoice, status: "void" } }), "invoice.voided");
  assert.equal(eventTypeFor({ table: t, before: invoice, after: { ...invoice, total: 90 } }), "invoice.updated");
  assert.equal(eventTypeFor({ table: t, before: invoice, after: null }), "invoice.deleted");
});

test("an invoice leaves the API in cents, whatever the table keeps", () => {
  const invoice = invoiceObject(
    {
      id: "inv-1", invoice_number: "INV-0007", status: "sent", customer_id: "p1", customer_name: "Alex",
      issue_date: new Date(2026, 8, 28), due_date: "2026-10-12", currency: "NZD",
      subtotal: "78.26", tax_total: "11.74", discount_total: "0", total: "90.00", amount_paid: "40.5",
    },
    [{ id: "l1", source_type: "product", source_id: "package-5", description: "5 pack", quantity: "1", unit_price: "90", tax_rate: "15", tax_amount: "11.74", discount_amount: "0", line_total: "90", service_date: null }],
  );
  assert.equal(invoice.total, 9000);
  assert.equal(invoice.amount_paid, 4050);
  assert.equal(invoice.amount_due, 4950);
  assert.equal(invoice.currency, "nzd");
  assert.equal(invoice.issue_date, "2026-09-28");
  assert.equal(invoice.due_date, "2026-10-12");
  assert.deepEqual(invoice.lines?.[0], {
    id: "l1", type: "product", booking_id: null, service_id: "package-5", description: "5 pack", quantity: 1,
    unit_amount: 9000, discount: 0, tax_rate: 15, tax: 1174, amount: 9000, service_date: null,
  });
  assert.equal(invoiceObject({ id: "x" }, null).lines, undefined, "a list row carries no lines");
});

test("a pg date column keeps its day in any server time zone", () => {
  assert.equal(dateOnly(new Date(2026, 0, 1)), "2026-01-01");
  assert.equal(dateOnly("2026-01-01"), "2026-01-01");
  assert.equal(dateOnly(null), null);
});

test("invoice lines are cents in, dollars to the billing engine, and checked", () => {
  assert.deepEqual(billingLines([{ description: "Lesson", unit_amount: 9000, booking_id: "appt-1" }])[0], {
    sourceType: "booking", sourceId: "appt-1", description: "Lesson", quantity: 1,
    unitPrice: 90, discountAmount: 0, taxRate: 0, serviceDate: "",
  });
  assert.equal(billingLines([{ description: "5 pack", unit_amount: 45000, service_id: "package-5" }])[0].sourceType, "product");
  assert.equal(billingLines([{ description: "Balls", unit_amount: 500 }])[0].sourceType, "manual");
  assert.throws(() => billingLines([]), /at least one/);
  assert.throws(() => billingLines([{ unit_amount: 100 }]), /description/);
  assert.throws(() => billingLines([{ description: "x", unit_amount: 12.5 }]), /whole number of cents/);
  assert.throws(() => billingLines([{ description: "x", unit_amount: 100, quantity: 0 }]), /quantity/);
});
