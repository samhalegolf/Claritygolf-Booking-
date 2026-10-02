import type { Config } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import { accountsForClarityPayAccount, syncClarityPay } from "./_shared/clarity-pay.mts";
import { accountsForStripeAccount } from "./_shared/integration-credentials.mts";
import { stripePlatform, STRIPE_CONNECTION_SETTING } from "./_shared/stripe.mts";
import { getDatabase } from "./_shared/database.mts";
import { refundPosSaleFromStripeCharge, settleTerminalPaymentFromWebhook } from "./billing-api.mts";
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
// One endpoint for every business. It is registered once, on Clarity's
// platform Stripe account under Connect ("events on connected accounts"), with
// the events below. Each event names the connected account it came from
// (event.account) and whether it is live; that pair finds the business. The
// signing secret is the platform's (STRIPE_CONNECT_WEBHOOK_SECRET, or the
// _TEST_ one for the test-mode endpoint), never a business's.
//
// Events: invoice.created, invoice.updated, invoice.finalized, invoice.sent,
// invoice.paid, invoice.payment_failed, invoice.voided,
// invoice.marked_uncollectible, invoice.deleted, charge.succeeded,
// charge.updated, charge.captured, charge.refunded,
// account.application.deauthorized, account.updated, payment_intent.succeeded.
//
// account.updated is how a Clarity Pay account switches on once Stripe has
// finished checking the business, even if they closed the tab mid-signup.
//
// payment_intent.succeeded settles a Tap to Pay sale whose phone never heard
// the answer (app closed, signal lost). The phone settles the same payment
// itself when it can; whichever gets there second finds it already done.

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Both modes' secrets: the live and test endpoints are signed separately. */
function webhookSecrets() {
  return [stripePlatform(true).webhookSecret, stripePlatform(false).webhookSecret].filter(Boolean);
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
  const secrets = webhookSecrets();
  if (!secrets.length) return json({ error: "not_configured", message: "Webhook secret is not configured." }, 503);

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature") || "";
  let event: Record<string, any> | null = null;
  for (const secret of secrets) {
    try {
      event = verifyStripeSignature(rawBody, signature, secret);
      break;
    } catch {
      // Try the other mode's secret.
    }
  }
  if (!event) return json({ error: "invalid_signature" }, 400);

  const stripeAccount = String(event.account || "");

  if (event.type === "account.updated") {
    try {
      const owners = await accountsForClarityPayAccount(stripeAccount, event.livemode === true);
      for (const owner of owners) await syncClarityPay(owner, event.livemode === true);
      return json({ received: true, clarityPay: owners.length });
    } catch (error) {
      console.error("stripe_billing_webhook:clarity_pay_sync_failed", error);
      return json({ error: "webhook_processing_failed" }, 500);
    }
  }

  const businesses = await accountsForStripeAccount(stripeAccount, event.livemode === true);
  // Acknowledged, not failed: a business that has disconnected is not coming
  // back for these, and a 4xx/5xx would only make Stripe retry for days.
  if (!businesses.length) return json({ received: true, ignored: "no_connected_business" });

  if (event.type === "account.application.deauthorized") {
    // Disconnected from Stripe's side. Forget the connection so the screens
    // stop saying "connected" to an account Clarity can no longer reach.
    for (const business of businesses) {
      await getDatabase().sql`
        DELETE FROM settings WHERE account_id = ${business} AND key = ${STRIPE_CONNECTION_SETTING}
      `;
    }
    return json({ received: true, disconnected: businesses.length });
  }

  const object = event?.data?.object || {};

  try {
    const results = [];
    for (const business of businesses) results.push(await handleEvent(event, object, business));
    return json({ received: true, results });
  } catch (error) {
    console.error("stripe_billing_webhook:failed", event?.type, error);
    return json(
      { error: "webhook_processing_failed", message: error instanceof Error ? error.message : "Processing failed." },
      500,
    );
  }
}

async function handleEvent(event: Record<string, any>, object: Record<string, any>, accountId: string) {
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
      return syncStripeInvoice(object, accountId);
    case "invoice.deleted":
      return deleteStripeInvoice(accountId, String(object?.id || ""));
    case "charge.succeeded":
    case "charge.updated":
    case "charge.captured":
      return syncStripeCharge(object, accountId);
    case "charge.refunded":
      // A refund made in the Stripe dashboard: the till sale it paid for
      // follows, as well as the mirrored charge.
      return {
        charge: await syncStripeCharge(object, accountId),
        sale: await refundPosSaleFromStripeCharge(accountId, object),
      };
    case "payment_intent.succeeded":
      return settleTerminalPaymentFromWebhook(accountId, String(object?.id || ""));
    default:
      // Unhandled event types are acknowledged so Stripe doesn't retry them.
      return { ignored: event?.type || "unknown" };
  }
}

export const config: Config = {
  path: "/api/stripe-billing-webhook",
};
