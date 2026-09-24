import type { Config } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import { integrationCredentials, resolveWebhookAccount } from "./_shared/integration-credentials.mts";
import {
  deleteStripeInvoice,
  syncStripeCharge,
  syncStripeInvoice,
} from "./_shared/stripe-billing.mts";

// Stripe webhook: keeps billing_invoices / billing_invoice_items live-mirrored
// from Stripe. All operations are idempotent upserts keyed on Stripe ids, so
// Stripe's at-least-once delivery and retries are harmless. Failures return 500
// so Stripe retries them.
//
// Products are deliberately not mirrored - see the note in
// _shared/stripe-billing.mts. product.* events are acknowledged and ignored.
//
// Setup: point a Stripe webhook endpoint at /api/stripe-billing-webhook with
// events invoice.created, invoice.updated, invoice.finalized, invoice.sent,
// invoice.paid, invoice.payment_failed, invoice.voided,
// invoice.marked_uncollectible, invoice.deleted, charge.succeeded,
// charge.updated, charge.captured, charge.refunded — and save that endpoint's
// signing secret in Integrations › Stripe.
//
// Per business: each registers its own URL (?account=<id>, as Integrations ›
// Stripe shows it) and its own signing secret. The URL names the business and
// only that business's secret verifies the delivery, so an event can land in
// no ledger but the one whose Stripe account signed it. A URL naming no
// business is the original workspace's, verified against the
// STRIPE_BILLING_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET env vars as before.

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function webhookSecret(accountId: string) {
  const read = await integrationCredentials(accountId, "stripe");
  return read("STRIPE_BILLING_WEBHOOK_SECRET") || read("STRIPE_WEBHOOK_SECRET");
}

function verifyStripeSignature(rawBody: string, signatureHeader: string, secret: string) {
  const parts = signatureHeader.split(",").reduce<Record<string, string[]>>((acc, item) => {
    const index = item.indexOf("=");
    if (index === -1) return acc;
    const key = item.slice(0, index);
    (acc[key] ||= []).push(item.slice(index + 1));
    return acc;
  }, {});
  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) throw new Error("Invalid signature header");

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new Error("Signature timestamp outside tolerance");

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  const matched = signatures.some((value) => {
    const candidate = Buffer.from(value, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!matched) throw new Error("Signature mismatch");
  return JSON.parse(rawBody);
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const business = await resolveWebhookAccount(req);
  if (!business) return json({ error: "unknown_business" }, 404);
  const accountId = () => business;
  const secret = await webhookSecret(business);
  if (!secret) return json({ error: "not_configured", message: "Webhook secret is not configured." }, 503);

  const rawBody = await req.text();
  let event: Record<string, any>;
  try {
    event = verifyStripeSignature(rawBody, req.headers.get("stripe-signature") || "", secret);
  } catch {
    return json({ error: "invalid_signature" }, 400);
  }

  const object = event?.data?.object || {};

  try {
    switch (event?.type) {
      case "invoice.created":
      case "invoice.updated":
      case "invoice.finalized":
      case "invoice.sent":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.payment_action_required":
      case "invoice.voided":
      case "invoice.marked_uncollectible":
        return json({ received: true, result: await syncStripeInvoice(object, accountId()) });
      case "invoice.deleted":
        return json({ received: true, result: await deleteStripeInvoice(accountId(), String(object?.id || "")) });
      case "charge.succeeded":
      case "charge.updated":
      case "charge.captured":
      case "charge.refunded":
        return json({ received: true, result: await syncStripeCharge(object, accountId()) });
      default:
        // Unhandled event types are acknowledged so Stripe doesn't retry them.
        return json({ received: true, ignored: event?.type || "unknown" });
    }
  } catch (error) {
    console.error("stripe_billing_webhook:failed", event?.type, error);
    return json(
      { error: "webhook_processing_failed", message: error instanceof Error ? error.message : "Processing failed." },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/stripe-billing-webhook",
};
