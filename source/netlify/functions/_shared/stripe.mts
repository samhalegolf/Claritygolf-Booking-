import { trimmedEnv } from "./values.mts";
/**
 * Stripe, and whose Stripe it is.
 *
 * Every charge this app takes runs through here, and the only question this
 * module exists to answer is which Stripe account the money lands in.
 *
 * A business takes cards one of two ways (see stripe-connect.mts):
 *
 *   Clarity Pay   Clarity creates the business's Stripe account and Stripe
 *                 runs the signup. Everything works: the till (QR and Tap
 *                 to Pay), the player portal and invoices. Clarity keeps a small cut of each
 *                 payment (the application fee).
 *   Own Stripe    The business signs in to a Stripe account it already has.
 *                 Invoices only, and Clarity takes nothing.
 *
 * Either way Clarity keeps only the connected account's id, and every request
 * is made with Clarity's platform key plus a Stripe-Account header naming that
 * account, so the money lands with the business and it gets its own payouts.
 *
 * Mode follows the business, not the deployment: a sandbox connects in test
 * mode and is served by the platform's test key, so it can never take real
 * money; a live business connects in live mode. The connection records which,
 * and the platform key is chosen from that.
 *
 * Platform settings (Netlify env, set once for Clarity, never per business):
 *
 *   live   STRIPE_CONNECT_CLIENT_ID, STRIPE_PLATFORM_SECRET_KEY,
 *          STRIPE_CONNECT_WEBHOOK_SECRET
 *   test   STRIPE_CONNECT_TEST_CLIENT_ID, STRIPE_PLATFORM_TEST_SECRET_KEY,
 *          STRIPE_CONNECT_TEST_WEBHOOK_SECRET
 *
 * Clarity Pay's cut (see clarityPayFeeCents), both modes:
 *
 *          CLARITY_PAY_FEE_PERCENT (default 0.5), CLARITY_PAY_FEE_FIXED_CENTS (default 0)
 */

/** Where a business's connection lives in `settings`. */
export const STRIPE_CONNECTION_SETTING = "accountStripeConnection";

/** Which way this business takes cards. See the top of this file. */
export type StripeRoute = "clarity_pay" | "own_stripe";

/** What each route can charge for. */
export type StripeFeatures = {
  invoices: boolean;
  till: boolean;
  portal: boolean;
  /** Tap to Pay (and later card readers) through Stripe Terminal. */
  terminal: boolean;
};

export function stripeFeatures(route: StripeRoute | ""): StripeFeatures {
  if (route === "clarity_pay") return { invoices: true, till: true, portal: true, terminal: true };
  if (route === "own_stripe") return { invoices: true, till: false, portal: false, terminal: false };
  return { invoices: false, till: false, portal: false, terminal: false };
}

export type StripeConnection = {
  /** The connected account, acct_… */
  account: string;
  livemode: boolean;
  route: StripeRoute;
};

export type StripeCredential = {
  /** Clarity's platform key for the connection's mode. */
  secret: string;
  /** Sent as Stripe-Account, so the request acts on the business's account. */
  account: string;
  livemode: boolean;
  route: StripeRoute;
};

export type StripeCredentialStatus = {
  /** Can this business take a payment right now? */
  configured: boolean;
  /** The connected account id, acct_… Not a secret. Empty when not connected. */
  account: string;
  /** True for a test-mode connection, which takes no real money. */
  testMode: boolean;
  /** Which way this business takes cards. Empty when not connected. */
  route: StripeRoute | "";
  features: StripeFeatures;
  /** Clarity Pay's cut of each card payment, so the business can see it. */
  fee: ClarityPayFee;
};

export type ClarityPayFee = {
  /** Percent of the charge, 0.5 = 0.5%. */
  percent: number;
  /** Flat amount per charge, in cents. */
  fixedCents: number;
};

export type StripePlatform = {
  clientId: string;
  secret: string;
  webhookSecret: string;
};

/** Clarity's own Connect app for one mode. Empty strings when not set up. */
export function stripePlatform(livemode: boolean): StripePlatform {
  return livemode
    ? {
        clientId: trimmedEnv("STRIPE_CONNECT_CLIENT_ID"),
        secret: trimmedEnv("STRIPE_PLATFORM_SECRET_KEY"),
        webhookSecret: trimmedEnv("STRIPE_CONNECT_WEBHOOK_SECRET"),
      }
    : {
        clientId: trimmedEnv("STRIPE_CONNECT_TEST_CLIENT_ID"),
        secret: trimmedEnv("STRIPE_PLATFORM_TEST_SECRET_KEY"),
        webhookSecret: trimmedEnv("STRIPE_CONNECT_TEST_WEBHOOK_SECRET"),
      };
}

function feeNumber(name: string, fallback: number) {
  const raw = trimmedEnv(name);
  const value = raw === "" ? fallback : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Clarity Pay's cut, as set for the platform. */
export function clarityPayFee(): ClarityPayFee {
  return {
    percent: feeNumber("CLARITY_PAY_FEE_PERCENT", 0.5),
    fixedCents: Math.round(feeNumber("CLARITY_PAY_FEE_FIXED_CENTS", 0)),
  };
}

/**
 * Clarity Pay's cut of a charge, in cents, sent to Stripe as the application
 * fee. Stripe moves it from the business's payment to Clarity's platform
 * balance; Stripe's own processing fee is still paid by the business, apart
 * from this.
 *
 * 0 means "take nothing" and callers leave the parameter off. Stripe refuses a
 * fee that is not less than the charge, so it is capped one cent under it.
 */
export function clarityPayFeeCents(amountCents: number, fee: ClarityPayFee = clarityPayFee()) {
  const cents = Math.round((amountCents * fee.percent) / 100 + fee.fixedCents);
  return Math.max(0, Math.min(cents, amountCents - 1));
}

/** A stored connection, or null for anything that is not one. */
export function parseStripeConnection(value: unknown): StripeConnection | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const record = (parsed || {}) as Record<string, unknown>;
  const account = typeof record.account === "string" ? record.account.trim() : "";
  if (!/^acct_[A-Za-z0-9]+$/.test(account)) return null;
  // Connections made before Clarity Pay existed were all Stripe sign-ins.
  const route: StripeRoute = record.route === "clarity_pay" ? "clarity_pay" : "own_stripe";
  return { account, livemode: record.livemode === true, route };
}

/**
 * Which Stripe account this business's money goes to, and the key to reach it.
 *
 * Throws rather than returning an unconfigured credential: every caller is
 * about to take money, and there is no useful way to half-do that. The 503 is
 * deliberate -- "not set up yet" is a service state, not a bad request.
 */
export function resolveStripeCredential(connectionValue: unknown): StripeCredential {
  const connection = parseStripeConnection(connectionValue);
  if (!connection) {
    throw Object.assign(
      new Error("Card payments are not set up yet. Connect Stripe in Settings."),
      { status: 503, code: "STRIPE_NOT_CONFIGURED" },
    );
  }
  const { secret } = stripePlatform(connection.livemode);
  if (!secret) {
    throw Object.assign(
      new Error("Card payments are unavailable right now. Clarity's Stripe platform is not set up."),
      { status: 503, code: "STRIPE_PLATFORM_NOT_CONFIGURED" },
    );
  }
  return { secret, account: connection.account, livemode: connection.livemode, route: connection.route };
}

/**
 * Stops a charge the business's route does not cover. The till, Tap to Pay and
 * the player portal are Clarity Pay only; a business on its own Stripe gets
 * invoices.
 */
export function requireStripeFeature(credential: StripeCredential, feature: keyof StripeFeatures) {
  if (stripeFeatures(credential.route)[feature]) return;
  const what =
    feature === "till"
      ? "Card payments at the till"
      : feature === "terminal"
        ? "Tap to Pay"
        : "Player portal purchases";
  throw Object.assign(
    new Error(`${what} need Clarity Pay. Set it up in Settings › Billing › Card payments.`),
    { status: 409, code: "CLARITY_PAY_REQUIRED" },
  );
}

/** The application fee for a charge on this connection. Only Clarity Pay pays one. */
export function applicationFeeCents(credential: StripeCredential, amountCents: number) {
  return credential.route === "clarity_pay" ? clarityPayFeeCents(amountCents) : 0;
}

/**
 * What a UI may know about the connection.
 *
 * Separate from resolveStripeCredential because this one must not throw: a
 * settings screen asking "am I set up?" wants an answer, not an exception.
 */
export function stripeCredentialStatus(connectionValue: unknown): StripeCredentialStatus {
  const connection = parseStripeConnection(connectionValue);
  const fee = clarityPayFee();
  if (!connection) {
    return { configured: false, account: "", testMode: false, route: "", features: stripeFeatures(""), fee };
  }
  const configured = Boolean(stripePlatform(connection.livemode).secret);
  return {
    configured,
    account: connection.account,
    testMode: !connection.livemode,
    route: connection.route,
    features: stripeFeatures(configured ? connection.route : ""),
    fee,
  };
}

/** The headers every request on a business's behalf carries. */
export function stripeHeaders(credential: Pick<StripeCredential, "secret" | "account">): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.secret}`,
    // No account means a request on Clarity's own platform account, such as
    // creating a Clarity Pay account.
    ...(credential.account ? { "Stripe-Account": credential.account } : {}),
  };
}

export async function stripeRequest(
  credential: Pick<StripeCredential, "secret" | "account">,
  path: string,
  options: { method?: string; params?: URLSearchParams; idempotencyKey?: string } = {},
) {
  const method = options.method || "GET";
  const query = method === "GET" && options.params ? `?${options.params.toString()}` : "";
  const response = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      ...stripeHeaders(credential),
      ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
      // A retried create with the same key returns the first result instead of
      // making a second object -- the difference between one charge and two.
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    ...(method === "GET" ? {} : { body: (options.params || new URLSearchParams()).toString() }),
  });
  const text = await response.text();
  if (!response.ok) {
    // The body can quote the request, and a request carries no secret -- but
    // the error is still truncated and the key is never in scope for the
    // message, so a Stripe failure cannot print a credential into a log.
    throw Object.assign(
      new Error(`Stripe ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`),
      { status: 502, code: "STRIPE_ERROR" },
    );
  }
  return text ? JSON.parse(text) : {};
}

export type StripeCheckoutInput = {
  /** Major units (12.50), not cents - converted here so no caller has to remember. */
  amount: number;
  currency: string;
  productName: string;
  productDescription?: string;
  customerEmail?: string;
  clientReferenceId?: string;
  metadata?: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
};

export async function createStripeCheckoutSession(
  credential: StripeCredential,
  input: StripeCheckoutInput,
) {
  const amountInCents = Math.round((Number(input.amount) || 0) * 100);
  if (amountInCents <= 0) {
    throw Object.assign(new Error("Amount must be greater than zero to take a payment."), {
      status: 400,
    });
  }

  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", input.successUrl);
  params.set("cancel_url", input.cancelUrl);
  if (input.clientReferenceId) params.set("client_reference_id", input.clientReferenceId);
  for (const [key, value] of Object.entries(input.metadata || {})) {
    if (value) params.set(`metadata[${key}]`, value);
  }
  if (input.customerEmail) params.set("customer_email", input.customerEmail);
  // A single line for the whole total keeps the charged amount identical to our
  // record (no per-line rounding drift; tax is already reflected in the total).
  params.set("line_items[0][quantity]", "1");
  const applicationFee = applicationFeeCents(credential, amountInCents);
  if (applicationFee > 0) params.set("payment_intent_data[application_fee_amount]", String(applicationFee));
  params.set("line_items[0][price_data][currency]", String(input.currency || "NZD").toLowerCase());
  params.set("line_items[0][price_data][unit_amount]", String(amountInCents));
  params.set("line_items[0][price_data][product_data][name]", input.productName);
  if (input.productDescription) {
    params.set("line_items[0][price_data][product_data][description]", input.productDescription);
  }

  const session = await stripeRequest(credential, "checkout/sessions", { method: "POST", params });
  if (!session.url) throw Object.assign(new Error("Stripe did not return a checkout URL."), { status: 502 });
  return { url: session.url as string, sessionId: (session.id as string) || "" };
}

export async function retrieveStripeCheckoutSession(
  credential: StripeCredential,
  sessionId: string,
) {
  const session = await stripeRequest(
    credential,
    `checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
  return {
    paid: session?.payment_status === "paid",
    expired: session?.status === "expired",
    paymentIntentId: typeof session?.payment_intent === "string" ? (session.payment_intent as string) : "",
    amountTotal: Number(session?.amount_total ?? 0),
    currency: String(session?.currency || "").toUpperCase(),
    metadata: (session?.metadata || {}) as Record<string, string>,
    clientReferenceId: String(session?.client_reference_id || ""),
  };
}

/**
 * Give a card payment back in full.
 *
 * The refund is made on the business's account, where the charge is. On
 * Clarity Pay, Clarity's cut goes back too: a sale that did not happen should
 * not cost the business Clarity's fee. Stripe's own card fee is Stripe's
 * business, as with a refund made in the Stripe dashboard.
 *
 * The idempotency key makes a double-click, or a retry after a dropped
 * connection, return the first refund instead of trying a second. A payment
 * someone already refunded in Stripe is not an error here: the money is back,
 * which is what was asked, so that refund is returned.
 */
export async function refundStripePayment(
  credential: Pick<StripeCredential, "secret" | "account" | "route">,
  paymentIntentId: string,
  idempotencyKey: string,
) {
  const params = new URLSearchParams();
  params.set("payment_intent", paymentIntentId);
  if (credential.route === "clarity_pay") params.set("refund_application_fee", "true");
  try {
    const refund = await stripeRequest(credential, "refunds", { method: "POST", params, idempotencyKey });
    return { id: String(refund?.id || ""), status: String(refund?.status || "") };
  } catch (error) {
    if (!String((error as Error)?.message || "").includes("charge_already_refunded")) throw error;
    const lookup = new URLSearchParams();
    lookup.set("payment_intent", paymentIntentId);
    lookup.set("limit", "1");
    const existing = await stripeRequest(credential, "refunds", { params: lookup });
    const first = (existing?.data || [])[0] as Record<string, unknown> | undefined;
    if (!first?.id) throw error;
    return { id: String(first.id), status: String(first.status || "") };
  }
}
