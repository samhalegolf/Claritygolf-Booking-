/**
 * Tap to Pay (Stripe Terminal).
 *
 * The money rules, end to end through billing-api with the database and Stripe
 * faked in memory:
 *
 *   - only Clarity Pay businesses get Terminal at all;
 *   - the amount charged is what the stored sale owes, whatever the phone says;
 *   - starting twice is one PaymentIntent, not two;
 *   - a payment that went through while the phone lost the answer is found and
 *     settled exactly once when it asks again;
 *   - one business can never touch another's sale.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseTerminalAttempt,
  settleTerminalPaymentFromWebhook,
  startTerminalPayment,
  terminalPaymentState,
} from "../billing-api.mts";
import { requireStripeFeature, resolveStripeCredential } from "./stripe.mts";
import { stripeLocationAddress, terminalAvailability, terminalIntentState } from "./terminal.mts";

const CLARITY_PAY = JSON.stringify({ account: "acct_business", livemode: true, route: "clarity_pay" });
const OWN_STRIPE = JSON.stringify({ account: "acct_business", livemode: true, route: "own_stripe" });

function withPlatformKey<T>(run: () => T): T {
  const previous = process.env.STRIPE_PLATFORM_SECRET_KEY;
  process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_live_platform_stub";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.STRIPE_PLATFORM_SECRET_KEY;
    else process.env.STRIPE_PLATFORM_SECRET_KEY = previous;
  }
}

/* --- Who gets Terminal ----------------------------------------------------- */

test("Clarity Pay allows Terminal", () => {
  withPlatformKey(() => {
    requireStripeFeature(resolveStripeCredential(CLARITY_PAY), "terminal");
    assert.equal(terminalAvailability(CLARITY_PAY, "active").available, true);
  });
});

test("an own-Stripe business is refused Terminal", () => {
  withPlatformKey(() => {
    assert.throws(
      () => requireStripeFeature(resolveStripeCredential(OWN_STRIPE), "terminal"),
      (error: { code?: string; message?: string }) =>
        error.code === "CLARITY_PAY_REQUIRED" && /Tap to Pay/.test(String(error.message)),
    );
    assert.equal(terminalAvailability(OWN_STRIPE, "active").available, false);
  });
});

test("an unconfigured business is refused Terminal", () => {
  withPlatformKey(() => {
    const status = terminalAvailability("", "");
    assert.equal(status.available, false);
    assert.match(status.reason, /not set up/);
  });
});

test("Terminal waits for Stripe to switch card payments on", () => {
  withPlatformKey(() => {
    const status = terminalAvailability(CLARITY_PAY, "pending");
    assert.equal(status.available, false);
    assert.equal(status.route, "clarity_pay");
  });
});

/* --- Reading Stripe -------------------------------------------------------- */

test("processing is never mistaken for failed", () => {
  assert.equal(terminalIntentState({ status: "processing" }), "processing");
  assert.equal(terminalIntentState({ status: "requires_capture" }), "processing");
  assert.equal(terminalIntentState({ status: "succeeded" }), "succeeded");
  assert.equal(terminalIntentState({ status: "canceled" }), "cancelled");
  assert.equal(terminalIntentState({ status: "requires_payment_method" }), "open");
  assert.equal(
    terminalIntentState({ status: "requires_payment_method", last_payment_error: { message: "Declined" } }),
    "declined",
  );
});

test("a one-line Clarity address becomes Stripe's street, city and postcode", () => {
  assert.deepEqual(stripeLocationAddress("12 Beach Rd, Takapuna, Auckland 0622", "nz"), {
    line1: "12 Beach Rd",
    city: "Auckland",
    postalCode: "0622",
    country: "NZ",
  });
  assert.deepEqual(stripeLocationAddress("The Range 24/7", "NZ"), {
    line1: "The Range 24/7",
    city: "",
    postalCode: "",
    country: "NZ",
  });
});

/* --- The flow, against a fake database and a fake Stripe -------------------- */

type Row = Record<string, unknown>;

/**
 * Just enough PostgREST: eq / is / in filters, order + limit, conditional
 * PATCH, and the unique constraints this flow leans on (one open Terminal
 * attempt per sale, one tender per sale and kind).
 */
function fakeHosts(options: { intentStatus?: string; sessionPaid?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    settings: [
      { account_id: "acct-a", key: "accountStripeConnection", value: CLARITY_PAY },
      { account_id: "acct-a", key: "accountCountry", value: "NZ" },
      {
        account_id: "acct-a",
        key: "locationsJson",
        value: JSON.stringify([{ id: "loc-range", name: "The Range", address: "1 Tee St, Auckland 1010", isDefault: true, active: true }]),
      },
      { account_id: "acct-b", key: "accountStripeConnection", value: CLARITY_PAY },
    ],
    billing_pos_transactions: [
      {
        id: "sale-1",
        account_id: "acct-a",
        receipt_number: "POS-1048",
        status: "pending",
        payment_method_kind: "clarity_pay",
        description: "Private Lesson",
        amount: 90,
        coupon_amount: 20,
        coupon_id: "cpn-1",
        coupon_reversed: false,
        stock_applied: false,
        currency: "NZD",
        customer_id: "person-craig",
        booking_id: "booking-1",
        source: "lesson",
        stripe_session_id: options.sessionPaid === undefined ? null : "cs_qr",
        stripe_payment_intent_id: null,
      },
    ],
    billing_pos_transaction_items: [],
    billing_terminal_payments: [],
    billing_terminal_locations: [],
    billing_payment_tenders: [],
  };
  const counts = { intentCreates: 0, paidTransitions: 0, sessionExpires: 0 };
  const intents = new Map<string, Row>();
  const byIdempotencyKey = new Map<string, string>();

  const matches = (row: Row, filters: Array<[string, string]>) =>
    filters.every(([column, expression]) => {
      const dot = expression.indexOf(".");
      const op = expression.slice(0, dot);
      const value = expression.slice(dot + 1);
      const cell = row[column];
      if (op === "eq") return String(cell ?? "") === value;
      if (op === "is") return value === "null" ? cell === null || cell === undefined : String(cell === true) === value;
      if (op === "in") {
        const list = value.replace(/^\(|\)$/g, "").split(",").map((entry) => entry.replace(/^"|"$/g, ""));
        return list.includes(String(cell ?? ""));
      }
      return true;
    });

  const original = globalThis.fetch;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";
  process.env.STRIPE_PLATFORM_SECRET_KEY = "sk_live_platform_stub";

  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method || "GET").toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;

    if (url.hostname === "api.stripe.com") {
      const path = url.pathname.replace(/^\/v1\//, "");
      const form = new URLSearchParams(String(init?.body || ""));
      if (path === "accounts/acct_business") return respond({ capabilities: { card_payments: "active" } });
      if (path === "terminal/locations") return respond({ id: "tml_range" });
      if (path === "terminal/connection_tokens") return respond({ secret: "pst_live_secret" });
      if (path === "payment_intents" && method === "POST") {
        const key = headers["Idempotency-Key"] || "";
        const existing = byIdempotencyKey.get(key);
        if (existing) return respond(intents.get(existing));
        counts.intentCreates += 1;
        const id = `pi_${counts.intentCreates}`;
        const intent = {
          id,
          client_secret: `${id}_secret`,
          amount: Number(form.get("amount")),
          currency: form.get("currency"),
          status: "requires_payment_method",
          application_fee_amount: Number(form.get("application_fee_amount") || 0),
          metadata: Object.fromEntries([...form].filter(([k]) => k.startsWith("metadata["))),
        };
        intents.set(id, intent);
        byIdempotencyKey.set(key, id);
        return respond(intent);
      }
      const intentMatch = /^payment_intents\/([^/]+)(\/cancel)?$/.exec(path);
      if (intentMatch) {
        const intent = intents.get(intentMatch[1]);
        if (!intent) return respond({ error: { message: "No such intent" } }, 404);
        if (intentMatch[2]) intent.status = "canceled";
        return respond(intent);
      }
      if (path === "checkout/sessions/cs_qr") {
        return respond({ id: "cs_qr", payment_status: options.sessionPaid ? "paid" : "unpaid", status: "open" });
      }
      if (path === "checkout/sessions/cs_qr/expire") {
        counts.sessionExpires += 1;
        return respond({ id: "cs_qr", status: "expired" });
      }
      throw new Error(`unstubbed Stripe ${method} ${path}`);
    }

    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const rows = tables[table];
    if (!rows) throw new Error(`unstubbed table ${table}`);
    const filters: Array<[string, string]> = [];
    let limit = Infinity;
    let onConflict: string[] = [];
    for (const [key, value] of url.searchParams) {
      if (key === "select" || key === "order") continue;
      if (key === "limit") limit = Number(value);
      else if (key === "on_conflict") onConflict = value.split(",");
      else filters.push([key, value]);
    }

    if (method === "GET") return respond(rows.filter((row) => matches(row, filters)).slice(0, limit));
    if (method === "POST") {
      const body = JSON.parse(String(init?.body || "[]")) as Row[];
      for (const row of body) {
        if (onConflict.length && rows.some((other) => onConflict.every((column) => other[column] === row[column]))) continue;
        if (
          table === "billing_terminal_payments" &&
          rows.some((other) => other.status === "open" && other.account_id === row.account_id && other.transaction_id === row.transaction_id)
        ) {
          return respond({ message: "duplicate key" }, 409);
        }
        rows.push({ ...row });
      }
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body || "{}")) as Row;
      const hit = rows.filter((row) => matches(row, filters));
      for (const row of hit) {
        if (table === "billing_pos_transactions" && patch.status === "paid" && row.status !== "paid") counts.paidTransitions += 1;
        Object.assign(row, patch);
      }
      return respond(hit.map((row) => ({ ...row })));
    }
    throw new Error(`unstubbed ${method} ${table}`);
  }) as typeof fetch;

  return {
    tables,
    intents,
    counts,
    sale: () => tables.billing_pos_transactions[0],
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("the charge is what the stored sale owes, not what the phone sends", async () => {
  const hosts = fakeHosts();
  try {
    const started = await startTerminalPayment("acct-a", "coach-1", {
      transactionId: "sale-1",
      amount: 1,
      amountCents: 100,
      device: { id: "device-1", name: "Sam's iPhone" },
    });
    assert.equal(started.state, "open");
    const intent = hosts.intents.get("pi_1")!;
    // $90 lesson, $20 of it on a voucher: the card owes $70.
    assert.equal(intent.amount, 7000);
    assert.equal(intent.currency, "nzd");
    assert.ok(Number(intent.application_fee_amount) > 0, "Clarity Pay's usual fee applies");
    assert.equal((intent.metadata as Row)["metadata[clarity_receipt_number]"], "POS-1048");
    const attempt = hosts.tables.billing_terminal_payments[0];
    assert.equal(attempt.device_name, "Sam's iPhone");
    assert.equal(attempt.actor_id, "coach-1");
    assert.equal(attempt.stripe_terminal_location_id, "tml_range");
  } finally {
    hosts.restore();
  }
});

test("starting twice picks up the same intent instead of making another", async () => {
  const hosts = fakeHosts();
  try {
    const first = await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    const second = await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    assert.equal(hosts.counts.intentCreates, 1);
    assert.equal("paymentIntentId" in second && second.paymentIntentId, "paymentIntentId" in first && first.paymentIntentId);
    assert.equal("reused" in second && second.reused, true);
  } finally {
    hosts.restore();
  }
});

test("a declined card can be tried again on the same intent", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    Object.assign(hosts.intents.get("pi_1")!, { last_payment_error: { message: "Your card was declined." } });
    const state = await terminalPaymentState("acct-a", "sale-1");
    assert.deepEqual(state, { state: "declined", message: "Your card was declined." });
    assert.equal(hosts.sale().status, "pending");
    const again = await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    assert.equal(again.state, "open");
    assert.equal(hosts.counts.intentCreates, 1);
  } finally {
    hosts.restore();
  }
});

test("a payment that succeeded while the phone lost the answer settles exactly once", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    // The tap went through at Stripe; the phone never heard back.
    Object.assign(hosts.intents.get("pi_1")!, {
      status: "succeeded",
      amount_received: 7000,
      latest_charge: { payment_method_details: { card_present: { brand: "visa", last4: "4242" } } },
    });
    const first = await terminalPaymentState("acct-a", "sale-1");
    const second = await terminalPaymentState("acct-a", "sale-1");
    assert.equal(first.state, "succeeded");
    assert.equal(second.state, "succeeded");
    assert.equal(hosts.counts.paidTransitions, 1);
    assert.equal(hosts.sale().payment_channel, "terminal_tap_to_pay");
    const tenders = hosts.tables.billing_payment_tenders;
    assert.deepEqual(
      tenders.map((tender) => [tender.tender_kind, tender.channel, tender.amount_cents]),
      [
        ["gift_value", "coupon", 2000],
        ["card", "terminal_tap_to_pay", 7000],
      ],
    );
    assert.equal(tenders[1].card_last4, "4242");
    // Starting again on a paid sale reports it paid rather than charging.
    const restart = await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    assert.equal(restart.state, "succeeded");
    assert.equal(hosts.counts.intentCreates, 1);
  } finally {
    hosts.restore();
  }
});

test("processing is reported as processing and blocks a fresh charge", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    hosts.intents.get("pi_1")!.status = "processing";
    assert.deepEqual(await terminalPaymentState("acct-a", "sale-1"), { state: "processing" });
    assert.deepEqual(await releaseTerminalAttempt("acct-a", "sale-1"), { state: "processing" });
    assert.equal((await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" })).state, "processing");
    assert.equal(hosts.counts.intentCreates, 1);
    assert.equal(hosts.intents.get("pi_1")!.status, "processing", "never cancelled while it might have charged");
  } finally {
    hosts.restore();
  }
});

test("cancelling frees the sale for a fresh attempt or the QR", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    assert.deepEqual(await releaseTerminalAttempt("acct-a", "sale-1"), { state: "cancelled" });
    assert.equal(hosts.intents.get("pi_1")!.status, "canceled");
    const again = await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    assert.equal("paymentIntentId" in again && again.paymentIntentId, "pi_2");
  } finally {
    hosts.restore();
  }
});

test("switching from the QR closes the QR so the customer cannot pay twice", async () => {
  const hosts = fakeHosts({ sessionPaid: false });
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    assert.equal(hosts.counts.sessionExpires, 1);
  } finally {
    hosts.restore();
  }
});

test("another business can never start, read or cancel this sale", async () => {
  const hosts = fakeHosts();
  try {
    await assert.rejects(startTerminalPayment("acct-b", "coach-2", { transactionId: "sale-1" }), { status: 404 });
    await assert.rejects(terminalPaymentState("acct-b", "sale-1"), { status: 404 });
    assert.deepEqual(await releaseTerminalAttempt("acct-b", "sale-1"), { state: "none" });
    assert.equal(hosts.counts.intentCreates, 0);
  } finally {
    hosts.restore();
  }
});

/* --- The webhook, for a phone that never heard back ------------------------ */

const succeeded = {
  status: "succeeded",
  amount_received: 7000,
  latest_charge: { payment_method_details: { card_present: { brand: "visa", last4: "4242" } } },
};

test("the webhook settles a tap the phone never heard back about, once", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    Object.assign(hosts.intents.get("pi_1")!, succeeded);
    const first = await settleTerminalPaymentFromWebhook("acct-a", "pi_1");
    assert.deepEqual(first, { settled: "sale-1", receipt: "POS-1048" });
    // Stripe redelivers, and the phone comes back and asks too.
    await settleTerminalPaymentFromWebhook("acct-a", "pi_1");
    assert.equal((await terminalPaymentState("acct-a", "sale-1")).state, "succeeded");
    assert.equal(hosts.counts.paidTransitions, 1);
    assert.equal(hosts.tables.billing_payment_tenders.length, 2);
    assert.equal(hosts.tables.billing_terminal_payments[0].status, "succeeded");
  } finally {
    hosts.restore();
  }
});

test("the webhook trusts Stripe's intent, not the event, and ignores what is not a tap", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    // The event says succeeded, but Stripe says the intent is still open.
    assert.deepEqual(await settleTerminalPaymentFromWebhook("acct-a", "pi_1"), { ignored: "intent_open" });
    // A QR or invoice payment has no Terminal attempt.
    assert.deepEqual(await settleTerminalPaymentFromWebhook("acct-a", "pi_other"), { ignored: "not_a_terminal_payment" });
    assert.equal(hosts.sale().status, "pending");
  } finally {
    hosts.restore();
  }
});

test("the webhook cannot settle another business's tap", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    Object.assign(hosts.intents.get("pi_1")!, succeeded);
    assert.deepEqual(await settleTerminalPaymentFromWebhook("acct-b", "pi_1"), { ignored: "not_a_terminal_payment" });
    assert.equal(hosts.sale().status, "pending");
  } finally {
    hosts.restore();
  }
});

test("a tap that lands on a voided sale is flagged for a person, not retried forever", async () => {
  const hosts = fakeHosts();
  try {
    await startTerminalPayment("acct-a", "coach-1", { transactionId: "sale-1" });
    Object.assign(hosts.intents.get("pi_1")!, succeeded);
    hosts.sale().status = "void";
    const result = await settleTerminalPaymentFromWebhook("acct-a", "pi_1");
    assert.deepEqual(result, { needsAttention: "POS_PAID_AFTER_CLOSE", transaction: "sale-1" });
    assert.equal(hosts.counts.paidTransitions, 0);
  } finally {
    hosts.restore();
  }
});
