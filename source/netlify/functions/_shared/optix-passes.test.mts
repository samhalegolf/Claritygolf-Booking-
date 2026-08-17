import assert from "node:assert/strict";
import test from "node:test";

import { classifyPassPurchase, isOptixPurchaseEvent, normalizeOptixPurchaseEvent } from "./optix-passes.mts";
import { amountInCents } from "./optix-payload.mts";

// A real new_sale, verbatim: Sam's test purchase of a lesson pass on
// 18 Aug 2026. This replaced the fixture built from Optix's docs — the docs
// promised invoice_id and invoice_number, and the real payload carries
// neither. What it does carry: number (the Optix sale number), account (the
// buyer's Optix account id), and inclusive_tax_rate. Still no email, no
// currency.
const newSale = {
  tax: "0.00",
  name: "Sam Hale",
  event: "new_sale",
  notes: "",
  total: "90.00",
  number: "00652",
  account: "396748",
  product: "30 Minute Golf Lesson Package",
  quantity: "1",
  tax_rate: "0.0000",
  client_id: "43d003fcf1eeb158ba6bd17e69cf8331faf11e30",
  user_name: "Sam Hale",
  description: "",
  unit_amount: "90.0000",
  account_name: "Sam Hale",
  organization_id: "25282",
  product_sale_id: "400324",
  created_datetime: "2026-08-18 08:41",
  created_timestamp: "1786999307",
  invoice_item_name: "Sale of 30 Minute Golf Lesson Package on August 18, 2026 at 8:41am (#400324)",
  request_signature: "35677519ff7b4035a6a078ac2dd94d176022a441",
  inclusive_tax_rate: "15.0000",
  invoice_item_quantity: "1.0000",
};

// Also real (17 Aug 2026): a bay-time top-up bought by a customer. The
// negative case — a sale, but not a lesson.
const extraHour = {
  event: "new_sale",
  product: "1 x Extra Hour",
  total: "10.00",
  quantity: "1",
  number: "00651",
  product_sale_id: "400145",
  user_name: "Ben Healy",
  created_timestamp: "1786982794",
  invoice_item_name: "Sale of 1 x Extra Hour on August 18, 2026 at 4:06am (#400145)",
};

// Still the documented shape — no real plan subscription has arrived yet.
const newPlanSubscription = {
  plan_template_id: "916",
  plan_template_name: "Gold Membership",
  account_plan_id: "29191",
  name: "Gold Membership for Sam",
  status: "ACTIVE",
  subscription_type: "member",
  created_datetime: "2026-08-13 16:00",
  start_datetime: "2026-08-13 12:33",
  price: "300.00",
  deposit: "50.00",
  set_up_fee: "10.00",
  free_trial_days: "7",
  subscribers: [{ user_name: "Sam", user_last_name: "Hale", user_fullname: "Sam Hale", email: "Samhalegolf@gmail.com" }],
  client_id: "7d5ee091717ab1a508",
  created_timestamp: 1786593600,
  organization_id: "6267",
  event: "new_plan_subscription",
  request_signature: "db2fdf29744bd5d61dfed00",
};

test("only the events that describe a purchase are treated as purchases", () => {
  assert.equal(isOptixPurchaseEvent("new_sale"), true);
  assert.equal(isOptixPurchaseEvent("new_plan_subscription"), true);
  // invoice_paid settles an invoice somewhere in Optix; with no invoice_id on
  // a sale it can never be tied to one, so it is not a purchase event and is
  // left to fall through as unsupported.
  assert.equal(isOptixPurchaseEvent("invoice_paid"), false);
  // Bookings keep going down the booking path.
  assert.equal(isOptixPurchaseEvent("new_member_booking"), false);
  // A modification is neither.
  assert.equal(isOptixPurchaseEvent("invoice_updated"), false);
  assert.equal(isOptixPurchaseEvent(""), false);
});

test("a real product sale is normalised from its real field names", () => {
  const purchase = normalizeOptixPurchaseEvent(newSale);
  assert.equal(purchase.eventType, "new_sale");
  // product_sale_id identifies the sale; number is the receipt the buyer sees.
  assert.equal(purchase.purchaseId, "400324");
  assert.equal(purchase.saleNumber, "00652");
  // The product itself, not invoice_item_name ("Sale of X on … (#400324)").
  assert.equal(purchase.itemName, "30 Minute Golf Lesson Package");
  assert.equal(purchase.memberName, "Sam Hale");
  assert.equal(purchase.quantity, 1);
  assert.equal(purchase.amountCents, 9_000);
  assert.equal(purchase.unitAmountCents, 9_000);
  // created_timestamp 1786999307 = 2026-08-17 20:41:47 UTC (8:41am NZ next day).
  assert.equal(purchase.purchasedAt, "2026-08-17T20:41:47.000Z");
});

test("a product sale carries no email and no currency", () => {
  // The limitation, asserted so it is not mistaken for a bug later: Optix
  // identifies the buyer of a sale by display name only, so a sale cannot be
  // auto-linked to a Clarity client.
  assert.equal(normalizeOptixPurchaseEvent(newSale).memberEmail, "");
  assert.equal(normalizeOptixPurchaseEvent(newSale).currency, "");
});

test("a plan subscription is normalised, including its subscriber", () => {
  const purchase = normalizeOptixPurchaseEvent(newPlanSubscription);
  assert.equal(purchase.eventType, "new_plan_subscription");
  assert.equal(purchase.purchaseId, "29191");
  // The template is the product; "name" is this subscriber's instance of it.
  assert.equal(purchase.itemName, "Gold Membership");
  assert.equal(purchase.memberName, "Sam Hale");
  // A plan does carry an email, so it is the one purchase that can auto-link.
  assert.equal(purchase.memberEmail, "samhalegolf@gmail.com");
  assert.equal(purchase.amountCents, 30_000);
  assert.equal(purchase.purchasedAt, "2026-08-13T04:00:00.000Z");
});

test("money is read whether it arrives in major or minor units", () => {
  assert.equal(amountInCents("517.50"), 51_750);
  assert.equal(amountInCents("45"), 4500);
  assert.equal(amountInCents("4500", true), 4500);
  assert.equal(amountInCents("$45.50"), 4550);
  assert.equal(amountInCents(""), null);
  assert.equal(amountInCents(undefined), null);
  // A cents field that nonetheless carries a decimal is major, not minor.
  assert.equal(amountInCents("45.00", true), 4500);
});

test("the real lesson package classifies as a pass", () => {
  // The word that settled the classifier: Sam's passes say "Lesson", not
  // "Pass" — "30 Minute Golf Lesson Package" was filed unknown until this.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent(newSale)), "pass");
});

test("a sale naming a Pass still classifies as a pass", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "10 Lesson Pass" })), "pass");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "5x Range Pass" })), "pass");
  // Case does not matter, and the wording may only be in the invoice line.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "Ten pack", invoice_item_name: "Sale of Ten pack (pass)" })), "pass");
});

test("a bay top-up is a sale but not a lesson", () => {
  // Real payload: says neither "lesson" nor "pass", so it stays unknown —
  // visible in the POS list as an Optix sale, just not tagged as a lesson.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent(extraHour)), "unknown");
});

test("a plan is never a Pass, whatever it is called", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent(newPlanSubscription)), "not_pass");
  // A plan recurs by definition, so even this wording cannot make it a Pass.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_plan_subscription", plan_template_name: "Coaching Pass" })), "not_pass");
});

test("a sale we cannot call is kept as unknown, never silently dropped", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "10 Session Bundle" })), "unknown");
});

test("'pass' or 'lesson' inside another word does not count", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "Compass Golf Club" })), "unknown");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "Passenger seat hire" })), "unknown");
});

test("a sale with no usable time still records, defaulting at the caller", () => {
  const purchase = normalizeOptixPurchaseEvent({ event: "new_sale", product: "Pass" });
  assert.equal(purchase.purchasedAt, "");
  assert.equal(purchase.amountCents, null);
  assert.equal(purchase.quantity, null);
  assert.equal(purchase.saleNumber, "");
});
