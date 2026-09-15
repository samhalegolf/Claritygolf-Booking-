/**
 * Stripe, and whose Stripe it is.
 *
 * Every charge this app takes runs through here, and the only question this
 * module exists to answer is which Stripe account the money lands in.
 *
 * Today there is one business, and its charges go to the platform's own Stripe
 * key in the environment. That is the right answer for one coach and the wrong
 * answer for two: the second business to sign up must not have its customers'
 * money arriving in the first one's account. So the credential is resolved per
 * account, from one function, with the platform key as the fallback rather
 * than as the rule:
 *
 *   account   the business pasted its own Stripe secret key into Settings.
 *             Money goes to them. Clarity never touches it.
 *   platform  no key of their own, so the platform's key is used and the money
 *             arrives in Clarity's Stripe account to be passed on.
 *
 * Nothing above this module knows which of the two happened, which is the
 * point: adding Stripe Connect later (an OAuth handshake and a Stripe-Account
 * header instead of a pasted key) is a change to resolveStripeCredential and
 * stripeRequest, and to nothing else in the app.
 *
 * THE KEY IS A SECRET. It is write-only from the browser's point of view:
 * stripeCredentialStatus() is the only thing any UI is ever given, and it
 * carries a masked tail and never the key itself.
 */

/** Where a business's own key lives. One name, so nothing has to guess it. */
export const STRIPE_SECRET_SETTING = "accountStripeSecretKey";

export type StripeCredential = {
  secret: string;
  /** Whose account the money lands in. */
  mode: "account" | "platform";
};

export type StripeCredentialStatus = {
  /** Can this business take a payment at all? */
  configured: boolean;
  mode: "account" | "platform" | "none";
  /** The last four characters, for "is that the right key" -- never the key. */
  maskedTail: string;
  /** True when the key is a Stripe test key, which takes no real money. */
  testMode: boolean;
};

const platformSecret = () => String(process.env.STRIPE_SECRET_KEY || "").trim();

/**
 * Is this the shape of a Stripe secret key?
 *
 * Deliberately not a call to Stripe: this runs when a coach pastes a key, and
 * the failure worth catching is the obvious one -- a publishable key, which
 * starts pk_ and would be accepted by nothing, or a whole line copied out of a
 * dashboard. A key that is well-formed but wrong still fails on first use, and
 * fails with Stripe's own message, which is more useful than ours.
 *
 * Restricted keys (rk_) are allowed and are the better choice: a coach only
 * needs Checkout write and read, and a restricted key limits what a leak costs.
 */
export function isStripeSecretShaped(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(text);
}

export function isStripeTestKey(value: unknown): boolean {
  return /^(sk|rk)_test_/.test(String(value ?? "").trim());
}

/** The last four, behind dots. Enough to recognise a key, useless if leaked. */
export function maskStripeSecret(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length < 4 ? "" : `••••${text.slice(-4)}`;
}

/**
 * Which Stripe account this business's money goes to.
 *
 * Throws rather than returning an unconfigured credential: every caller is
 * about to take money, and there is no useful way to half-do that. The 503 is
 * deliberate -- "not set up yet" is a service state, not a bad request.
 */
export function resolveStripeCredential(accountSecret?: unknown): StripeCredential {
  const own = String(accountSecret ?? "").trim();
  if (own) return { secret: own, mode: "account" };

  const platform = platformSecret();
  if (platform) return { secret: platform, mode: "platform" };

  throw Object.assign(
    new Error("Card payments are not set up yet. Add a Stripe key in Settings."),
    { status: 503, code: "STRIPE_NOT_CONFIGURED" },
  );
}

/**
 * What a UI may know about the credential. Never the key.
 *
 * Separate from resolveStripeCredential because this one must not throw: a
 * settings screen asking "am I set up?" wants an answer, not an exception.
 */
export function stripeCredentialStatus(accountSecret?: unknown): StripeCredentialStatus {
  const own = String(accountSecret ?? "").trim();
  if (own) {
    return {
      configured: true,
      mode: "account",
      maskedTail: maskStripeSecret(own),
      testMode: isStripeTestKey(own),
    };
  }
  const platform = platformSecret();
  return {
    configured: Boolean(platform),
    mode: platform ? "platform" : "none",
    // The platform's key is not this coach's to see any part of.
    maskedTail: "",
    testMode: platform ? isStripeTestKey(platform) : false,
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
      Authorization: `Bearer ${credential.secret}`,
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
