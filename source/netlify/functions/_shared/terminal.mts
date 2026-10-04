/**
 * Stripe Terminal: Tap to Pay on iPhone and Android, and card readers later.
 *
 * Terminal is one more way Clarity Pay collects a card for a POS sale that
 * already exists. It never creates a sale, never decides an amount the server
 * did not, and never issues anything -- that is all pos-settlement.mts. What
 * lives here is the Stripe side: connection tokens for the phone, the
 * PaymentIntent a tap confirms, and reading back what happened.
 *
 * Money goes where every other Clarity Pay charge goes: a direct charge on the
 * business's connected account (the Stripe-Account header), with Clarity's
 * usual application fee. Stripe's in-person fee is the business's, as with any
 * card. Own-Stripe businesses do not get Terminal (see stripeFeatures).
 */

import {
  applicationFeeCents,
  parseStripeConnection,
  stripePlatform,
  stripeRequest,
  type StripeCredential,
  type StripeRoute,
} from "./stripe.mts";

export type TerminalAvailability = {
  available: boolean;
  route: StripeRoute | "";
  /** Tap to Pay on iPhone or Android. Readers are not offered yet. */
  tapToPay: boolean;
  testMode: boolean;
  /** Why not, in words a coach can act on. Empty when available. */
  reason: string;
};

/**
 * Can this business take Tap to Pay, as far as the server can tell?
 *
 * The phone adds its own half (is it a phone that can, has the coach allowed
 * location). This half is the one the phone must not decide for itself.
 */
export function terminalAvailability(
  connectionValue: unknown,
  cardPaymentsCapability: string,
): TerminalAvailability {
  const connection = parseStripeConnection(connectionValue);
  const route = connection?.route || "";
  const testMode = connection ? !connection.livemode : false;
  const no = (reason: string): TerminalAvailability => ({ available: false, route, tapToPay: false, testMode, reason });
  if (!connection) return no("Card payments are not set up yet. Connect Clarity Pay in Settings.");
  if (connection.route !== "clarity_pay") return no("Tap to Pay needs Clarity Pay. Set it up in Settings › Billing › Card payments.");
  if (!stripePlatform(connection.livemode).secret) return no("Card payments are unavailable right now.");
  if (cardPaymentsCapability !== "active") return no("Stripe has not finished setting up card payments for this business yet.");
  return { available: true, route, tapToPay: true, testMode, reason: "" };
}

/** card_payments on the connected account, read with the platform key. */
export async function cardPaymentsCapability(credential: StripeCredential) {
  const account = await stripeRequest(
    { secret: credential.secret, account: "" },
    `accounts/${encodeURIComponent(credential.account)}`,
  );
  return String(account?.capabilities?.card_payments || "");
}

/**
 * A short-lived secret the phone's Terminal SDK uses to talk to Stripe as this
 * business. Made on every ask, never stored; Stripe expires it on its own.
 * Scoped to the location so a token cannot connect a reader somewhere else.
 */
export async function createConnectionToken(credential: StripeCredential, stripeLocationId: string) {
  const params = new URLSearchParams();
  if (stripeLocationId) params.set("location", stripeLocationId);
  const token = await stripeRequest(credential, "terminal/connection_tokens", { method: "POST", params });
  if (!token?.secret) throw Object.assign(new Error("Stripe did not return a connection token."), { status: 502 });
  return String(token.secret);
}

/**
 * A free-text Clarity address, as the structured one Stripe wants for a
 * Terminal location.
 *
 * Clarity keeps an address as one line ("12 Beach Rd, Takapuna, Auckland
 * 0622"). Stripe wants street, city and postcode. The first part is the street,
 * a 4-6 digit group is the postcode, and the last remaining part is the city.
 * When that is not enough Stripe says so, and the coach is told to fill the
 * address in -- better than inventing parts of it.
 */
export function stripeLocationAddress(address: string, country: string) {
  const parts = String(address || "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  let postalCode = "";
  for (let index = parts.length - 1; index >= 0 && !postalCode; index -= 1) {
    const match = /\b(\d{4,6})\b/.exec(parts[index]);
    if (match && index > 0) {
      postalCode = match[1];
      parts[index] = parts[index].replace(match[0], "").trim();
    }
  }
  const [line1 = "", ...rest] = parts.filter(Boolean);
  const place = rest.filter(Boolean);
  return {
    line1,
    city: place[place.length - 1] || "",
    postalCode,
    country: String(country || "").toUpperCase(),
  };
}

export async function createTerminalLocation(
  credential: StripeCredential,
  input: { displayName: string; address: string; country: string; clarityLocationId: string },
) {
  const address = stripeLocationAddress(input.address, input.country);
  if (!address.line1 || !/^[A-Z]{2}$/.test(address.country)) {
    throw Object.assign(
      new Error(`Tap to Pay needs a street address for ${input.displayName}. Add one in Settings › Locations.`),
      { status: 409, code: "TERMINAL_LOCATION_ADDRESS" },
    );
  }
  const params = new URLSearchParams();
  params.set("display_name", input.displayName.slice(0, 100) || "Clarity");
  params.set("address[line1]", address.line1);
  if (address.city) params.set("address[city]", address.city);
  if (address.postalCode) params.set("address[postal_code]", address.postalCode);
  params.set("address[country]", address.country);
  params.set("metadata[clarity_location_id]", input.clarityLocationId);
  try {
    const location = await stripeRequest(credential, "terminal/locations", { method: "POST", params });
    return String(location?.id || "");
  } catch (error) {
    if (String((error as Error)?.message || "").includes("(400)")) {
      throw Object.assign(
        new Error(
          `Stripe needs a fuller address for ${input.displayName} before Tap to Pay can be used there -- street, city and postcode. Update it in Settings › Locations.`,
        ),
        { status: 409, code: "TERMINAL_LOCATION_ADDRESS" },
      );
    }
    throw error;
  }
}

export type TerminalIntentInput = {
  amountCents: number;
  currency: string;
  /** Unique per Clarity attempt, so a retried create returns the same intent. */
  idempotencyKey: string;
  metadata: Record<string, string>;
  description: string;
};

/** The intent a tap confirms. Card present, captured as soon as it clears. */
export async function createTerminalPaymentIntent(credential: StripeCredential, input: TerminalIntentInput) {
  if (!(input.amountCents > 0)) {
    throw Object.assign(new Error("There is nothing for a card to pay."), { status: 409, code: "POS_NOTHING_DUE" });
  }
  const params = new URLSearchParams();
  params.set("amount", String(input.amountCents));
  params.set("currency", input.currency.toLowerCase());
  params.append("payment_method_types[]", "card_present");
  params.set("capture_method", "automatic");
  if (input.description) params.set("description", input.description.slice(0, 500));
  const fee = applicationFeeCents(credential, input.amountCents);
  if (fee > 0) params.set("application_fee_amount", String(fee));
  for (const [key, value] of Object.entries(input.metadata)) {
    if (value) params.set(`metadata[${key}]`, value.slice(0, 500));
  }
  const intent = await stripeRequest(credential, "payment_intents", {
    method: "POST",
    params,
    idempotencyKey: input.idempotencyKey,
  });
  return readIntent(intent);
}

export type TerminalIntentState = "open" | "processing" | "succeeded" | "declined" | "cancelled";

export type TerminalIntent = {
  id: string;
  clientSecret: string;
  amountCents: number;
  currency: string;
  state: TerminalIntentState;
  /** Stripe's decline message, when there is one. */
  declineMessage: string;
  cardBrand: string;
  cardLast4: string;
};

/**
 * Where a PaymentIntent stands, in the terms the till cares about.
 *
 * "declined" is still retryable -- Stripe leaves the intent open for another
 * card -- but it is worth saying out loud rather than silently offering the tap
 * again. "processing" is the one that must never be treated as failed: the card
 * may well have been charged.
 */
export function terminalIntentState(intent: Record<string, unknown>): TerminalIntentState {
  const status = String(intent?.status || "");
  if (status === "succeeded") return "succeeded";
  if (status === "canceled") return "cancelled";
  if (status === "processing" || status === "requires_capture") return "processing";
  if (status === "requires_payment_method" && intent?.last_payment_error) return "declined";
  return "open";
}

function readIntent(intent: Record<string, unknown>): TerminalIntent {
  const charge = (intent?.latest_charge && typeof intent.latest_charge === "object"
    ? intent.latest_charge
    : {}) as Record<string, unknown>;
  const details = (charge.payment_method_details || {}) as Record<string, Record<string, unknown> | undefined>;
  const card = details.card_present || details.interac_present || {};
  const lastError = (intent?.last_payment_error || {}) as Record<string, unknown>;
  return {
    id: String(intent?.id || ""),
    clientSecret: String(intent?.client_secret || ""),
    amountCents: Number(intent?.amount_received || intent?.amount || 0),
    currency: String(intent?.currency || "").toUpperCase(),
    state: terminalIntentState(intent),
    declineMessage: String(lastError.message || ""),
    cardBrand: String(card.brand || ""),
    cardLast4: String(card.last4 || ""),
  };
}

export async function retrieveTerminalPaymentIntent(credential: StripeCredential, id: string) {
  const params = new URLSearchParams();
  params.append("expand[]", "latest_charge");
  return readIntent(
    await stripeRequest(credential, `payment_intents/${encodeURIComponent(id)}`, { params }),
  );
}

/**
 * Cancel an intent nobody is going to pay. Only an intent Stripe still holds
 * open can be cancelled; one that is processing or paid is left alone and
 * reported back, because cancelling is not the same as refunding.
 */
export async function cancelTerminalPaymentIntent(credential: StripeCredential, id: string) {
  const current = await retrieveTerminalPaymentIntent(credential, id);
  if (current.state !== "open" && current.state !== "declined") return current;
  const params = new URLSearchParams();
  params.append("expand[]", "latest_charge");
  return readIntent(
    await stripeRequest(credential, `payment_intents/${encodeURIComponent(id)}/cancel`, { method: "POST", params }),
  );
}
