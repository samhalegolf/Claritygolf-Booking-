// Tap to Pay: talking to /api/billing/terminal/* and deciding what the screen
// says.
//
// The one rule everything here serves: never tell a coach a payment failed when
// it might have gone through. Once a card has been read and sent to Stripe the
// screen does not say "failed" on its own authority -- it says "Checking
// payment" and asks the server until the server knows. A retry can never
// double-charge anyway, because the server hands back the same PaymentIntent
// for the same sale and Stripe lets an intent succeed only once; the checking
// is so the coach is never told to charge again when the customer already
// paid.

import { useEffect, useState } from "react";
import { installConnectionTokenBridge, nativeTerminal, type CollectOutcome } from "../../native/clarityTerminal";
import type { PosTransaction } from "./types";
import { t } from "../../lib/i18n";

export type PosTender = {
  kind: string;
  channel: string;
  amount: number;
  currency: string;
  cardBrand: string;
  cardLast4: string;
};

export type TerminalServerState =
  | { state: "succeeded"; transaction: PosTransaction; tenders: PosTender[]; issuedPasses?: string[] }
  | { state: "open"; paymentIntentId?: string; clientSecret?: string; amount?: number; currency?: string }
  | { state: "processing" }
  | { state: "declined"; message?: string }
  | { state: "cancelled" }
  | { state: "none" };

// What the Tap to Pay screen is showing. See the rule at the top of the file
// for why "unknown" exists and why "failed" is only reached before a charge
// could have happened (or once the server has said nothing was taken).
export type TapState =
  | { kind: "connecting"; progress?: number }
  | { kind: "ready_to_tap" }
  | { kind: "reading"; message: string }
  | { kind: "processing" }
  | { kind: "unknown" }
  | { kind: "succeeded"; transaction: PosTransaction; tenders: PosTender[]; issuedPasses: string[] }
  | { kind: "declined"; message: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/** Can a new tap be offered from here? Never while money may be moving. */
export function canRetry(state: TapState) {
  return state.kind === "declined" || state.kind === "cancelled" || state.kind === "failed";
}

/** What the phone reported after a tap, before the server has been asked. */
export function stateAfterCollect(outcome: CollectOutcome): TapState {
  if (outcome.stage !== "confirm") {
    if (outcome.outcome === "cancelled") return { kind: "cancelled" };
    // Nothing reached Stripe as a charge: the card was not read, or the
    // intent could not be loaded. Safe to say so and offer the tap again.
    return { kind: "failed", message: outcome.message || t("The card could not be read. Try again.") };
  }
  // Confirmed or not, a confirm was attempted. Only the server can say.
  return { kind: "processing" };
}

// After a confirm, how many "still open" answers in a row mean the charge
// never reached Stripe. A few seconds' worth, so an answer still in flight at
// Stripe has time to land first.
export const OPEN_ANSWERS_BEFORE_FAILED = 3;

/**
 * The server's answer, as a screen state.
 *
 * `openCount` is how many times in a row the server has said the intent is
 * still open since the confirm. Only after several is that read as "it did not
 * go through" -- and even then the retry reuses the same intent, so a late
 * success cannot become a second charge.
 */
export function stateFromServer(answer: TerminalServerState, openCount: number): TapState {
  switch (answer.state) {
    case "succeeded":
      return {
        kind: "succeeded",
        transaction: answer.transaction,
        tenders: answer.tenders || [],
        issuedPasses: answer.issuedPasses || [],
      };
    case "declined":
      return { kind: "declined", message: answer.message || t("The card was declined.") };
    case "cancelled":
    case "none":
      return { kind: "cancelled" };
    case "open":
      return openCount >= OPEN_ANSWERS_BEFORE_FAILED
        ? { kind: "failed", message: t("The payment didn't go through. Nothing was charged.") }
        : { kind: "processing" };
    default:
      return { kind: "processing" };
  }
}

/** A tender line as the receipt says it: "Clarity Credit", "Visa •••• 4242". */
export function tenderLabel(tender: PosTender) {
  if (tender.kind === "gift_value") return t("Gift voucher");
  if (tender.kind === "clarity_credit") return "Clarity Credit";
  if (tender.kind === "card") {
    const brand = tender.cardBrand
      ? tender.cardBrand.charAt(0).toUpperCase() + tender.cardBrand.slice(1)
      : t("Card");
    return tender.cardLast4 ? `${brand} •••• ${tender.cardLast4}` : brand;
  }
  return tender.kind;
}

// --- Server -------------------------------------------------------------------

async function terminalJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/billing/terminal/${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!response.ok) throw new Error(data?.message || t("Tap to Pay could not reach Clarity."));
  return data as T;
}

export type TerminalStatus = {
  available: boolean;
  testMode: boolean;
  reason: string;
  locations: Array<{ id: string; name: string; isDefault: boolean }>;
};

export const terminalApi = {
  status: () => terminalJson<TerminalStatus>("status"),
  location: (locationId: string) =>
    terminalJson<{ stripeLocationId: string; name: string; testMode: boolean }>("location", {
      method: "POST",
      body: JSON.stringify({ locationId }),
    }),
  connectionToken: (locationId: string) =>
    terminalJson<{ secret: string }>("connection-token", {
      method: "POST",
      body: JSON.stringify({ locationId }),
    }).then((data) => data.secret),
  // Names the sale and nothing about the money: the server prices it.
  start: (transactionId: string, locationId: string) =>
    terminalJson<TerminalServerState>("payment-intent", {
      method: "POST",
      body: JSON.stringify({ transactionId, locationId, device: terminalDevice() }),
    }),
  state: (transactionId: string) =>
    terminalJson<TerminalServerState>(`payment-intent/${encodeURIComponent(transactionId)}/status`),
  cancel: (transactionId: string) =>
    terminalJson<TerminalServerState>("cancel", { method: "POST", body: JSON.stringify({ transactionId }) }),
};

// --- This device ----------------------------------------------------------------

const DEVICE_KEY = "clarity-terminal-device";
const LOCATION_KEY = "clarity-terminal-location";

function readLocal(key: string) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage off: the device just goes unnamed.
  }
}

/** Which phone took a payment, for the audit trail. Not a security boundary. */
function terminalDevice() {
  let id = readLocal(DEVICE_KEY);
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}`;
    writeLocal(DEVICE_KEY, id);
  }
  return { id, name: "iPhone (Tap to Pay)" };
}

export function savedTerminalLocation() {
  return readLocal(LOCATION_KEY);
}

export function saveTerminalLocation(locationId: string) {
  writeLocal(LOCATION_KEY, locationId);
}

// --- Availability -----------------------------------------------------------------

type Availability = { ready: false } | { ready: true; status: TerminalStatus };

let availabilityOnce: Promise<Availability> | null = null;

async function loadAvailability(): Promise<Availability> {
  const plugin = nativeTerminal();
  if (!plugin) return { ready: false };
  const [device, status] = await Promise.all([
    plugin.isSupported().catch(() => ({ supported: false, reason: "" })),
    terminalApi.status().catch(() => null),
  ]);
  if (!device.supported || !status?.available) return { ready: false };
  installConnectionTokenBridge(plugin, () => terminalApi.connectionToken(savedTerminalLocation()));
  return { ready: true, status };
}

/**
 * Whether to offer Tap to Pay here: inside the staff app, on an iPhone that
 * can, for a business the server says may. Asked once per page load. Anywhere
 * else -- every browser -- this is "not ready" and the QR works as it always
 * has.
 */
export function useTapToPay(): Availability {
  const [availability, setAvailability] = useState<Availability>({ ready: false });
  useEffect(() => {
    if (!nativeTerminal()) return;
    let cancelled = false;
    availabilityOnce ||= loadAvailability();
    availabilityOnce.then((result) => {
      if (!cancelled) setAvailability(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return availability;
}

// --- History ------------------------------------------------------------------

const CHANNEL_LABELS: Record<string, string> = {
  terminal_tap_to_pay: "Tap to Pay",
  terminal_reader: t("Card reader"),
  stripe_checkout: "QR",
};

/**
 * How a sale reads in a list: the method, plus how the card arrived when that
 * was recorded -- "Clarity Pay · Tap to Pay" -- so one payment method does not
 * have to be split into several to tell them apart.
 */
export function posMethodLabel(sale: Pick<PosTransaction, "paymentMethodName" | "paymentChannel">) {
  const channel = CHANNEL_LABELS[sale.paymentChannel || ""];
  return channel ? `${sale.paymentMethodName} · ${channel}` : sale.paymentMethodName;
}

/**
 * Did Clarity Pay take a card for this sale (QR or tap)? Refunding one sends
 * the money back through Stripe, so the till asks before it does.
 */
export function isClarityPayCardSale(sale: Pick<PosTransaction, "paymentChannel">) {
  return Object.hasOwn(CHANNEL_LABELS, sale.paymentChannel || "");
}

/** What a refund puts back on the card: the sale less any voucher part. */
export function cardRefundAmount(sale: Pick<PosTransaction, "amount" | "couponAmount">) {
  return Math.max(0, Math.round(((Number(sale.amount) || 0) - (Number(sale.couponAmount) || 0)) * 100) / 100);
}
