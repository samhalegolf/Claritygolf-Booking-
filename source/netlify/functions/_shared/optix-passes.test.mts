import assert from "node:assert/strict";
import test from "node:test";

import { classifyPassPurchase, isOptixPurchaseEvent, normalizeOptixPurchaseEvent } from "./optix-passes.mts";
import { amountInCents } from "./optix-payload.mts";

// The three payment events, shaped like the booking webhooks Optix actually
// sends: flat, form-encoded, everything a string. The exact field names for a
// purchase are unconfirmed, so these cover the plausible spellings rather than
// asserting one true shape.
const invoicePaid = {
  event: "invoice_paid",
  invoice_id: "inv-9001",
  member_name: "Sam",
  member_last_name: "Hale",
  member_email: "Samhalegolf@gmail.com",
  description: "10 Lesson Pass",
  amount: "450.00",
  currency: "nzd",
  paid_timestamp: "1786593600",
};

test("only the three purchase events are treated as purchases", () => {
  assert.equal(isOptixPurchaseEvent("invoice_paid"), true);
  assert.equal(isOptixPurchaseEvent("new_sale"), true);
  assert.equal(isOptixPurchaseEvent("new_plan_subscription"), true);
  // Bookings keep going down the booking path.
  assert.equal(isOptixPurchaseEvent("new_member_booking"), false);
  // A modification is not a purchase.
  assert.equal(isOptixPurchaseEvent("invoice_updated"), false);
  assert.equal(isOptixPurchaseEvent(""), false);
});

test("a purchase payload is normalised into a purchase record", () => {
  const purchase = normalizeOptixPurchaseEvent(invoicePaid);
  assert.equal(purchase.eventType, "invoice_paid");
  assert.equal(purchase.purchaseId, "inv-9001");
  assert.equal(purchase.memberName, "Sam Hale");
  // Email is the only join key Optix gives us, so it is always lower-cased.
  assert.equal(purchase.memberEmail, "samhalegolf@gmail.com");
  assert.equal(purchase.itemName, "10 Lesson Pass");
  assert.equal(purchase.amountCents, 45_000);
  assert.equal(purchase.currency, "NZD");
  // Optix sends unix seconds; 1786593600 is 13 Aug 2026 16:00 NZ.
  assert.equal(purchase.purchasedAt, "2026-08-13T04:00:00.000Z");
});

test("money is read whether it arrives in major or minor units", () => {
  // A decimal major amount.
  assert.equal(amountInCents("45.00"), 4500);
  assert.equal(amountInCents("45"), 4500);
  // A *_cents field holding an integer is already minor.
  assert.equal(amountInCents("4500", true), 4500);
  // Currency symbols and separators do not break it.
  assert.equal(amountInCents("$45.50"), 4550);
  assert.equal(amountInCents(""), null);
  assert.equal(amountInCents(undefined), null);
  // A cents field that nonetheless carries a decimal is major, not minor.
  assert.equal(amountInCents("45.00", true), 4500);
});

test("a purchase naming a Pass classifies as a Pass", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent(invoicePaid)), "pass");
  // Whatever field carries the wording, and whatever the event.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product_name: "5x Range Pass" })), "pass");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_plan_subscription", plan_name: "Coaching pass" })), "pass");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product_type: "pass", name: "Ten pack" })), "pass");
});

test("a recurring purchase is a Plan, not a Pass", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_plan_subscription", plan_name: "Gold membership", interval: "monthly" })), "not_pass");
  // A one-off marker is not a recurrence, so it stays open rather than excluded.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", name: "Glove", interval: "one-time" })), "unknown");
});

test("a purchase we cannot call is kept as unknown, never silently dropped", () => {
  // This is the case that matters: if Optix words a Pass some other way, it has
  // to stay visible so the classifier can be corrected against it.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", name: "10 Lesson Bundle" })), "unknown");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "invoice_paid" })), "unknown");
});

test("'pass' inside another word does not count as a Pass", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", name: "Compass Golf Club" })), "unknown");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", name: "Passenger seat hire" })), "unknown");
});

test("a purchase with no usable time still records, defaulting at the caller", () => {
  const purchase = normalizeOptixPurchaseEvent({ event: "new_sale", name: "Pass" });
  assert.equal(purchase.purchasedAt, "");
  assert.equal(purchase.amountCents, null);
});
