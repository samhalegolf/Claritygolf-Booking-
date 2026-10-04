// What the Tap to Pay screen says, and when it lets a coach charge again.
//
// The dangerous mistake is saying "failed" when a card may have been charged:
// the coach charges again and the customer pays twice. These pin down that the
// screen only offers another tap before a charge could have happened, or once
// the server has said none did.

import assert from "node:assert/strict";
import test from "node:test";

import {
  OPEN_ANSWERS_BEFORE_FAILED,
  canRetry,
  cardRefundAmount,
  isClarityPayCardSale,
  posMethodLabel,
  stateAfterCollect,
  stateFromServer,
  tapToPayName,
  tenderLabel,
} from "./terminal";
import type { PosTransaction } from "./types";

test("a card never read is safe to try again", () => {
  const state = stateAfterCollect({ outcome: "failed", stage: "collect", message: "Card removed too soon" });
  assert.deepEqual(state, { kind: "failed", message: "Card removed too soon" });
  assert.equal(canRetry(state), true);
});

test("stopping before a tap is a cancel, and safe to try again", () => {
  const state = stateAfterCollect({ outcome: "cancelled", stage: "collect" });
  assert.equal(state.kind, "cancelled");
  assert.equal(canRetry(state), true);
});

test("any outcome at confirm waits for the server instead of claiming failure", () => {
  for (const outcome of ["failed", "confirmed", "cancelled"] as const) {
    const state = stateAfterCollect({ outcome, stage: "confirm", message: "Network lost" });
    assert.equal(state.kind, "processing", outcome);
    assert.equal(canRetry(state), false);
  }
});

test("the server saying paid is paid", () => {
  const transaction = { id: "sale-1", receiptNumber: "POS-1048" } as PosTransaction;
  const state = stateFromServer({ state: "succeeded", transaction, tenders: [] }, 0);
  assert.equal(state.kind, "succeeded");
});

test("still open right after a confirm keeps checking, and only later reads as not charged", () => {
  for (let count = 1; count < OPEN_ANSWERS_BEFORE_FAILED; count += 1) {
    assert.equal(stateFromServer({ state: "open" }, count).kind, "processing");
  }
  const settled = stateFromServer({ state: "open" }, OPEN_ANSWERS_BEFORE_FAILED);
  assert.equal(settled.kind, "failed");
  assert.equal(canRetry(settled), true);
});

test("processing at Stripe is never offered a retry", () => {
  const state = stateFromServer({ state: "processing" }, 5);
  assert.equal(state.kind, "processing");
  assert.equal(canRetry(state), false);
});

test("a decline carries Stripe's words", () => {
  assert.deepEqual(stateFromServer({ state: "declined", message: "Insufficient funds." }, 0), {
    kind: "declined",
    message: "Insufficient funds.",
  });
});

test("tenders read the way a receipt does", () => {
  const card = { kind: "card", channel: "terminal_tap_to_pay", amount: 70, currency: "NZD", cardBrand: "visa", cardLast4: "4242" };
  assert.equal(tenderLabel(card), "Visa •••• 4242");
  assert.equal(tenderLabel({ ...card, kind: "gift_value", cardBrand: "", cardLast4: "" }), "Gift voucher");
});

test("history names the channel under the one payment method", () => {
  assert.equal(
    posMethodLabel({ paymentMethodName: "Clarity Pay", paymentChannel: "terminal_tap_to_pay" }),
    "Clarity Pay · Tap to Pay",
  );
  assert.equal(posMethodLabel({ paymentMethodName: "Cash", paymentChannel: "" }), "Cash");
});

test("only QR and Tap to Pay sales are refunded to a card", () => {
  assert.equal(isClarityPayCardSale({ paymentChannel: "terminal_tap_to_pay" }), true);
  assert.equal(isClarityPayCardSale({ paymentChannel: "stripe_checkout" }), true);
  assert.equal(isClarityPayCardSale({ paymentChannel: "" }), false);
  assert.equal(isClarityPayCardSale({ paymentChannel: "manual_cash" }), false);
});

test("the card gets back the sale less the voucher part", () => {
  assert.equal(cardRefundAmount({ amount: 120, couponAmount: 50 }), 70);
  assert.equal(cardRefundAmount({ amount: 80.1, couponAmount: 0 }), 80.1);
});

test("the method is named for the phone it runs on", () => {
  const global = globalThis as { Capacitor?: unknown };
  try {
    global.Capacitor = { getPlatform: () => "ios" };
    assert.equal(tapToPayName(), "Tap to Pay on iPhone");
    global.Capacitor = { getPlatform: () => "android" };
    assert.equal(tapToPayName(), "Tap to Pay");
  } finally {
    delete global.Capacitor;
  }
});
