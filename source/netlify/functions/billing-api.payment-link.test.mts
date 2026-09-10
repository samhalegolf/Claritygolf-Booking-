/**
 * The Clarity Pay link that goes out with an emailed invoice.
 *
 * Two things about it are easy to get wrong and expensive when you do.
 *
 * It is a Stripe *payment link*, not a Checkout Session. A session expires 24
 * hours after it is created; a link emailed with an invoice on 7-day terms
 * would be dead by the time most clients opened it. The link is minted once and
 * kept on the invoice, so a resend points at the same page rather than opening a
 * second live way to charge for the same work.
 *
 * And it charges what is *outstanding*, not the invoice total - part-paying an
 * invoice and then emailing a link for the full amount charges twice for the
 * part already settled.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveInvoicePaymentLink } from "./billing-api.mts";

type Call = { url: string; method: string; body: string };

function stubHosts(options: { onPatch?: (body: string) => void } = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = String(init?.body || "");
    calls.push({ url, method, body });

    if (url.endsWith("/v1/prices")) {
      return new Response(JSON.stringify({ id: "price_stub" }), { status: 200 });
    }
    if (url.endsWith("/v1/payment_links")) {
      return new Response(
        JSON.stringify({ id: "plink_stub", url: "https://pay.stripe.com/plink_stub" }),
        { status: 200 },
      );
    }
    if (url.includes("/rest/v1/billing_invoices") && method === "PATCH") {
      options.onPatch?.(body);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unstubbed ${method} ${url}`);
  }) as typeof fetch;

  return {
    calls,
    stripeCalls: () => calls.filter((call) => call.url.includes("api.stripe.com")),
    restore: () => { globalThis.fetch = original; },
  };
}

// Only the fields resolveInvoicePaymentLink actually reads.
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    invoiceNumber: "SHG-0101",
    status: "sent",
    currency: "NZD",
    total: 250,
    amountPaid: 0,
    paymentLinkUrl: "",
    ...overrides,
  } as never;
}

const branding = { businessName: "Sam Hale Golf" } as never;

test("an invoice that already has a link keeps it - Stripe is never asked again", async () => {
  const stub = stubHosts();
  try {
    const url = await resolveInvoicePaymentLink(
      "acct-1",
      invoice({ paymentLinkUrl: "https://pay.stripe.com/plink_first" }),
      branding,
      "https://book.example.com",
    );
    assert.equal(url, "https://pay.stripe.com/plink_first");
    assert.deepEqual(stub.stripeCalls(), [], "a resend must not mint a second live way to pay");
  } finally {
    stub.restore();
  }
});

test("a new link is priced on what is outstanding, not the invoice total", async () => {
  const stub = stubHosts();
  try {
    await resolveInvoicePaymentLink(
      "acct-1",
      invoice({ total: 250, amountPaid: 100 }),
      branding,
      "https://book.example.com",
    );
    const price = stub.stripeCalls().find((call) => call.url.endsWith("/v1/prices"));
    assert.ok(price, "a price is created for the payment link");
    assert.match(price.body, /unit_amount=15000/, "charges the 150 still owed, not the 250 billed");
    assert.match(price.body, /currency=nzd/);
  } finally {
    stub.restore();
  }
});

test("the link is stored on the invoice, and carries the invoice on its metadata", async () => {
  let patched = "";
  const stub = stubHosts({ onPatch: (body) => { patched = body; } });
  try {
    const url = await resolveInvoicePaymentLink("acct-1", invoice(), branding, "https://book.example.com");
    assert.equal(url, "https://pay.stripe.com/plink_stub");

    const saved = JSON.parse(patched) as Record<string, string>;
    assert.equal(saved.payment_link_url, "https://pay.stripe.com/plink_stub", "kept, so a resend reuses it");
    assert.equal(saved.payment_link_id, "plink_stub");

    const link = stub.stripeCalls().find((call) => call.url.endsWith("/v1/payment_links"));
    assert.ok(link);
    const params = new URLSearchParams(link.body);
    assert.equal(params.get("metadata[invoice_id]"), "inv-1");
    assert.equal(
      params.get("payment_intent_data[metadata][invoice_id]"),
      "inv-1",
      "the charge carries it too - the link's own metadata never reaches the PaymentIntent",
    );
    assert.equal(params.get("restrictions[completed_sessions][limit]"), "1", "an invoice is payable once");
  } finally {
    stub.restore();
  }
});

test("a settled invoice gets no link at all", async () => {
  for (const settled of [
    invoice({ status: "paid", amountPaid: 250 }),
    invoice({ status: "void" }),
    invoice({ total: 0 }),
  ]) {
    const stub = stubHosts();
    try {
      assert.equal(await resolveInvoicePaymentLink("acct-1", settled, branding, "https://book.example.com"), "");
      assert.deepEqual(stub.stripeCalls(), [], "nothing to pay, so nothing is minted");
    } finally {
      stub.restore();
    }
  }
});
