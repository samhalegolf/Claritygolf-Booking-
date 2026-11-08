/**
 * Paying for a lesson online: nothing is invoiced until Stripe says it was
 * paid, then the webhook writes the invoice already marked paid. A player's
 * share is an invoice of its own and the booker is asked only for the rest; an
 * invoice paid through its Stripe link is marked paid by the webhook.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkBookingLinks, ensureBookerPayment, settleInvoiceCheckoutFromWebhook, settleLessonCheckoutFromWebhook } from "../billing-api.mts";

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
    const route = routes.find(([table, method]) => (call.url.includes(`/rest/v1/${table}?`) || call.url.endsWith(`/rest/v1/${table}`)) && call.method === method);
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

test("a split-group booker whose share is already paid is not sent to pay again", async () => {
  const stub = stubSupabase([
    ["billing_booking_invoice_links", "GET", () => []],
    ["billing_invoice_items", "GET", () => [{ invoice_id: "inv-b", source_id: "appt-1:booker", line_total: 80 }]],
    ["billing_invoices", "GET", () => [{ id: "inv-b", status: "paid" }]],
  ]);
  try {
    const result = await ensureBookerPayment("acct-1", {
      bookingId: "appt-1", share: true, amount: 80, name: "Sam", email: "sam@example.test",
      description: "Shared Lesson", week: 0, day: 0,
    }, "https://book.example");
    assert.deepEqual(result, { paid: true, payUrl: "" });
    assert.equal(stub.calls.filter((call) => call.method !== "GET").length, 0);
  } finally {
    stub.restore();
  }
});

const lessonSession = (overrides: Record<string, unknown> = {}) => ({
  id: "cs_1",
  payment_status: "paid",
  payment_intent: "pi_1",
  amount_total: 16000,
  metadata: {
    account_id: "acct-1", lesson_payment: "booking", booking_id: "appt-1", attendee_id: "",
    amount: "160", name: "Sam Hale", email: "sam@example.test", description: "1 Hour Golf Lesson", week: "0", day: "0",
  },
  ...overrides,
});

test("a lesson paid online is invoiced only now, already paid, against its booking", async () => {
  const posts: Record<string, string[]> = {};
  const patches: string[] = [];
  const stub = stubSupabase([
    ["settings", "GET", () => []],
    ["billing_booking_invoice_links", "GET", () => []],
    ["billing_booking_invoice_links", "POST", () => null],
    ["billing_invoices", "GET", (call) => {
      if (call.url.includes("reference=eq.")) return [];
      if (call.url.includes("select=customer_name")) return [{ customer_name: "Sam Hale" }];
      if (call.url.includes("invoice_number")) return [];
      return [{ id: JSON.parse(posts.billing_invoices?.[0] || "[{}]")[0].id, invoice_number: "SHG-0500", status: "sent", total: 160, customer_name: "Sam Hale" }];
    }],
    ["billing_invoices", "POST", (call) => { (posts.billing_invoices ||= []).push(call.body); return null; }],
    ["billing_invoices", "PATCH", (call) => { patches.push(call.body); return [{ id: "x" }]; }],
    ["billing_invoice_items", "GET", () => []],
    ["billing_invoice_items", "POST", (call) => { (posts.billing_invoice_items ||= []).push(call.body); return null; }],
    ["people", "GET", () => []],
  ]);
  try {
    const result = await settleLessonCheckoutFromWebhook("acct-1", lessonSession());
    assert.equal(result?.paid, 160);
    const invoice = JSON.parse(posts.billing_invoices[0])[0];
    assert.equal(invoice.reference, "pi_1");
    assert.equal(invoice.customer_name, "Sam Hale");
    const line = JSON.parse(posts.billing_invoice_items[0])[0];
    assert.equal(line.source_type, "booking");
    assert.equal(line.source_id, "appt-1");
    const paid = patches.map((body) => JSON.parse(body)).find((body) => body.status === "paid");
    assert.equal(paid?.amount_paid, 160);
  } finally {
    stub.restore();
  }
});

test("a lesson payment Stripe delivers twice is invoiced once", async () => {
  const stub = stubSupabase([["billing_invoices", "GET", () => [{ id: "inv-paid" }]]]);
  try {
    assert.deepEqual(await settleLessonCheckoutFromWebhook("acct-1", lessonSession()), { invoice: "inv-paid", alreadySettled: "paid" });
    assert.equal(stub.calls.filter((call) => call.method !== "GET").length, 0);
  } finally {
    stub.restore();
  }
});

test("an unpaid lesson checkout, or one for another business, writes nothing", async () => {
  const stub = stubSupabase([]);
  try {
    assert.deepEqual(await settleLessonCheckoutFromWebhook("acct-1", lessonSession({ payment_status: "unpaid" })), { ignored: "not_paid", booking: "appt-1" });
    assert.equal(await settleLessonCheckoutFromWebhook("acct-2", lessonSession()), null);
    assert.equal(await settleLessonCheckoutFromWebhook("acct-1", { payment_status: "paid", metadata: { invoice_id: "inv-1", account_id: "acct-1" } }), null);
    assert.equal(stub.calls.length, 0);
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
