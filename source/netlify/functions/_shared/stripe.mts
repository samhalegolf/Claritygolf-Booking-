/**
 * Stripe, and whose Stripe it is.
 *
 * Every charge this app takes runs through here, and the only question this
 * module exists to answer is which Stripe account the money lands in.
 *
 * Each business signs in to its own Stripe with Stripe Connect (see
 * stripe-connect.mts) and Clarity keeps only the connected account's id.
 * Every request is then made with Clarity's platform key plus a
 * Stripe-Account header naming that account, so the money lands with the
 * business and Clarity never holds a business's key.
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
 */

/** Where a business's connection lives in `settings`. */
export const STRIPE_CONNECTION_SETTING = "accountStripeConnection";

export type StripeConnection = {
  /** The connected account, acct_… */
  account: string;
  livemode: boolean;
};

export type StripeCredential = {
  /** Clarity's platform key for the connection's mode. */
  secret: string;
  /** Sent as Stripe-Account, so the request acts on the business's account. */
  account: string;
  livemode: boolean;
};

export type StripeCredentialStatus = {
  /** Can this business take a payment right now? */
  configured: boolean;
  /** The connected account id, acct_… Not a secret. Empty when not connected. */
  account: string;
  /** True for a test-mode connection, which takes no real money. */
  testMode: boolean;
};

export type StripePlatform = {
  clientId: string;
  secret: string;
  webhookSecret: string;
};

function env(name: string) {
  return String(globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

/** Clarity's own Connect app for one mode. Empty strings when not set up. */
export function stripePlatform(livemode: boolean): StripePlatform {
  return livemode
    ? {
        clientId: env("STRIPE_CONNECT_CLIENT_ID"),
        secret: env("STRIPE_PLATFORM_SECRET_KEY"),
        webhookSecret: env("STRIPE_CONNECT_WEBHOOK_SECRET"),
      }
    : {
        clientId: env("STRIPE_CONNECT_TEST_CLIENT_ID"),
        secret: env("STRIPE_PLATFORM_TEST_SECRET_KEY"),
        webhookSecret: env("STRIPE_CONNECT_TEST_WEBHOOK_SECRET"),
      };
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
  return { account, livemode: record.livemode === true };
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
  return { secret, account: connection.account, livemode: connection.livemode };
}

/**
 * What a UI may know about the connection.
 *
 * Separate from resolveStripeCredential because this one must not throw: a
 * settings screen asking "am I set up?" wants an answer, not an exception.
 */
export function stripeCredentialStatus(connectionValue: unknown): StripeCredentialStatus {
  const connection = parseStripeConnection(connectionValue);
  if (!connection) return { configured: false, account: "", testMode: false };
  return {
    configured: Boolean(stripePlatform(connection.livemode).secret),
    account: connection.account,
    testMode: !connection.livemode,
  };
}

/** The headers every request on a business's behalf carries. */
export function stripeHeaders(credential: StripeCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.secret}`,
    "Stripe-Account": credential.account,
  };
}

export async function stripeRequest(
  credential: StripeCredential,
  path: string,
  options: { method?: string; params?: URLSearchParams } = {},
) {
  const method = options.method || "GET";
  const query = method === "GET" && options.params ? `?${options.params.toString()}` : "";
  const response = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      ...stripeHeaders(credential),
      ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
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
