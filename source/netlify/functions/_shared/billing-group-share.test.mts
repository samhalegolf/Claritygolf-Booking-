/**
 * Group shares: each player a booker invites to a custom group gets their own
 * invoice for their share, the booker is asked only for the rest, and an
 * invoice paid through its Stripe link is marked paid by the webhook.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkBookingLinks, ensureBookerPayment, ensureGroupShareInvoice, settleInvoiceCheckoutFromWebhook } from "../billing-api.mts";

type Call = { url: string; method: string; body: string };
type Route = (call: Call) => unknown;

/** Answers Supabase calls from `routes` (first match by table and method); anything else fails the test. */
function stubSupabase(routes: Array<[string, string, Route]>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: decodeURIComponent(String(input)), method: (init?.method || "GET").toUpperCase(), body: String(init?.body || "") };
    calls.push(call);
    const route = routes.find(([table, method]) => call.url.includes(`/rest/v1/${table}?`) && call.method === method);
    if (!route) throw new Error(`unstubbed ${call.method} ${call.url}`);
    const answer = route[2](call);
    return answer === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const paidSession = (overrides: Record<string, unknown> = {}) => ({
  payment_status: "paid",
  amount_total: 4000,
  metadata: { invoice_id: "inv-1", account_id: "acct-1" },
  ...overrides,
});

test("a paid pay-link checkout marks its invoice paid", async () => {
  const patches: string[] = [];
  const stub = stubSupabase([
    ["billing_invoices", "GET", () => [{ id: "inv-1", status: "sent", total: 40, amount_paid: 0, customer_name: "Jo" }]],
    ["billing_invoices", "PATCH", (call) => { patches.push(call.body); return [{ id: "inv-1", total: 40 }]; }],
    ["billing_invoice_items", "GET", () => []],
  ]);
  try {
    const result = await settleInvoiceCheckoutFromWebhook("acct-1", paidSession());
    assert.deepEqual(result, { invoice: "inv-1", paid: 40 });
    assert.equal(JSON.parse(patches[0]).status, "paid");
    assert.equal(JSON.parse(patches[0]).amount_paid, 40);
  } finally {
    stub.restore();
  }
});

test("a redelivered webhook leaves a paid invoice alone", async () => {
  const stub = stubSupabase([["billing_invoices", "GET", () => [{ id: "inv-1", status: "paid", total: 40, amount_paid: 40 }]]]);
  try {
    assert.deepEqual(await settleInvoiceCheckoutFromWebhook("acct-1", paidSession()), { invoice: "inv-1", alreadySettled: "paid" });
    assert.equal(stub.calls.filter((call) => call.method === "PATCH").length, 0);
  } finally {
    stub.restore();
  }
});

test("a session for another business, or with no invoice, is not an invoice payment", async () => {
  const stub = stubSupabase([]);
  try {
    assert.equal(await settleInvoiceCheckoutFromWebhook("acct-2", paidSession()), null);
    assert.equal(await settleInvoiceCheckoutFromWebhook("acct-1", paidSession({ metadata: { pos_transaction_id: "sale-1", account_id: "acct-1" } })), null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("each lesson's live share invoices are totalled, and a voided one is not", async () => {
  const stub = stubSupabase([
    ["billing_booking_invoice_links", "GET", () => []],
    ["billing_invoice_items", "GET", () => [
      { invoice_id: "inv-a", source_id: "appt-1:attendee-1", line_total: 40 },
      { invoice_id: "inv-b", source_id: "appt-1:attendee-2", line_total: 40 },
      { invoice_id: "inv-c", source_id: "appt-2:attendee-1", line_total: 25 },
    ]],
    ["billing_invoices", "GET", () => [
      { id: "inv-a", status: "sent" },
      { id: "inv-b", status: "void" },
      { id: "inv-c", status: "paid" },
    ]],
  ]);
  try {
    const { groupShares } = await checkBookingLinks("acct-1", ["appt-1", "appt-2"]);
    assert.deepEqual(groupShares, { "appt-1": 40, "appt-2": 25 });
  } finally {
    stub.restore();
  }
});

test("an invite sent again reuses the player's share invoice rather than making a second", async () => {
  const stub = stubSupabase([
    ["billing_invoice_items", "GET", (call) =>
      call.url.includes("source_type=eq.group_share")
        ? [{ invoice_id: "inv-a", source_id: "appt-1:attendee-1", line_total: 40 }]
        : []],
    ["billing_invoices", "GET", () => [{
      id: "inv-a", invoice_number: "SHG-0102", status: "sent", total: 40, amount_paid: 0,
      payment_link_url: "https://pay.stripe.com/plink_kept", currency: "NZD",
    }]],
    ["settings", "GET", () => []],
  ]);
  try {
    const share = await ensureGroupShareInvoice("acct-1", {
      bookingId: "appt-1", attendeeId: "attendee-1", name: "Jo", email: "jo@example.test",
      amount: 40, description: "Shared Lesson", week: 0, day: 0,
    }, "https://book.example");
    assert.equal(share?.invoiceId, "inv-a");
    assert.equal(share?.payUrl, "https://pay.stripe.com/plink_kept");
    assert.equal(stub.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    stub.restore();
  }
});

test("the booker paying their share of a split group pays a share invoice of their own", async () => {
  const stub = stubSupabase([
    ["pass_redemptions", "GET", () => []],
    ["billing_booking_invoice_links", "GET", () => []],
    ["billing_invoice_items", "GET", (call) =>
      call.url.includes("source_id=eq.appt-1:booker")
        ? [{ invoice_id: "inv-b", source_id: "appt-1:booker", line_total: 80 }]
        : [{ id: "line-1", source_type: "group_share", source_id: "appt-1:booker", line_total: 80 }]],
    ["billing_invoices", "GET", () => [{
      id: "inv-b", invoice_number: "SHG-0103", status: "sent", total: 80, amount_paid: 0,
      payment_link_url: "https://pay.stripe.com/plink_booker", currency: "NZD",
    }]],
    ["settings", "GET", () => []],
  ]);
  try {
    const result = await ensureBookerPayment("acct-1", {
      bookingId: "appt-1", share: true, amount: 80, name: "Sam", email: "sam@example.test",
      description: "Shared Lesson", week: 0, day: 0,
    }, "https://book.example");
    assert.deepEqual(result, { paid: false, payUrl: "https://pay.stripe.com/plink_booker" });
    assert.equal(stub.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    stub.restore();
  }
});

test("a lesson the coach already put on a bigger invoice is not paid from the booking page", async () => {
  const stub = stubSupabase([
    ["pass_redemptions", "GET", () => []],
    ["billing_booking_invoice_links", "GET", () => [{ booking_id: "appt-1", invoice_id: "inv-month" }]],
    ["billing_invoices", "GET", () => [{ id: "inv-month", invoice_number: "SHG-0200", status: "sent", total: 320, amount_paid: 0, currency: "NZD" }]],
    ["billing_invoice_items", "GET", () => [
      { id: "l1", source_type: "booking", source_id: "appt-1", line_total: 160 },
      { id: "l2", source_type: "booking", source_id: "appt-2", line_total: 160 },
    ]],
  ]);
  try {
    await assert.rejects(
      ensureBookerPayment("acct-1", {
        bookingId: "appt-1", share: false, amount: 160, name: "Sam", email: "sam@example.test",
        description: "Lesson", week: 0, day: 0,
      }, "https://book.example"),
      (error: Error & { status?: number }) => error.status === 409,
    );
  } finally {
    stub.restore();
  }
});

test("a split-group booker cannot pay their share of a lesson the coach already invoiced", async () => {
  const stub = stubSupabase([
    ["pass_redemptions", "GET", () => []],
    ["billing_booking_invoice_links", "GET", () => [{ booking_id: "appt-1", invoice_id: "inv-coach" }]],
    ["billing_invoices", "GET", () => [{ id: "inv-coach", invoice_number: "SHG-0300", status: "sent" }]],
  ]);
  try {
    await assert.rejects(
      ensureBookerPayment("acct-1", {
        bookingId: "appt-1", share: true, amount: 80, name: "Sam", email: "sam@example.test",
        description: "Shared Lesson", week: 0, day: 0,
      }, "https://book.example"),
      (error: Error & { status?: number }) => error.status === 409,
    );
  } finally {
    stub.restore();
  }
});

test("a lesson a package credit already paid for is not charged again", async () => {
  const stub = stubSupabase([["pass_redemptions", "GET", () => [{ id: "red-1" }]]]);
  try {
    const result = await ensureBookerPayment("acct-1", {
      bookingId: "appt-1", share: false, amount: 160, name: "Sam", email: "sam@example.test",
      description: "Lesson", week: 0, day: 0,
    }, "https://book.example");
    assert.deepEqual(result, { paid: true, payUrl: "" });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
