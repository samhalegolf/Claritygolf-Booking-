import assert from "node:assert/strict";
import test from "node:test";

import { classifyPassPurchase, isOptixInvoicePaidEvent, isOptixPurchaseEvent, normalizeOptixPurchaseEvent } from "./optix-passes.mts";
import { amountInCents } from "./optix-payload.mts";

// The documented Optix payloads, verbatim in shape: form-encoded, almost
// everything a string. These are the real field names, not plausible ones.
const newSale = {
  product_sale_id: "102024",
  product: "10 Lesson Pass",
  account: "1701",
  account_name: "The Cube Team",
  number: "100778",
  user_name: "Richard Johnson",
  invoice_item_name: "Sale of 10 Lesson Pass (#102024)",
  description: "Product sale",
  quantity: "1.0000",
  unit_amount: "450.0000",
  tax_rate: "0.15",
  tax: "67.50",
  total: "517.50",
  notes: null,
  created_datetime: "2026-08-13 16:00",
  invoice_id: "298448",
  invoice_number: "71312",
  client_id: "ce81e1fbf3d7ba561d5d",
  created_timestamp: 1786593600,
  organization_id: 3568,
  event: "new_sale",
  request_signature: "1207e01d133aa4329c48ff0f",
};

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

// Every invoice_paid we have received has exactly these six keys. There is
// nothing else in it — no amount, no product, no buyer.
const invoicePaid = {
  event: "invoice_paid",
  client_id: "43d003fcf1eeb158ba6bd17e69cf8331faf11e30",
  invoice_id: "298448",
  organization_id: "25282",
  created_timestamp: "1786921226",
  request_signature: "6091ccc960fbbfd6680ad116378643c8271a0ffe",
};

test("only the events that describe a purchase are treated as purchases", () => {
  assert.equal(isOptixPurchaseEvent("new_sale"), true);
  assert.equal(isOptixPurchaseEvent("new_plan_subscription"), true);
  // invoice_paid settles a sale, it does not describe one.
  assert.equal(isOptixPurchaseEvent("invoice_paid"), false);
  assert.equal(isOptixInvoicePaidEvent("invoice_paid"), true);
  // Bookings keep going down the booking path.
  assert.equal(isOptixPurchaseEvent("new_member_booking"), false);
  // A modification is neither.
  assert.equal(isOptixPurchaseEvent("invoice_updated"), false);
  assert.equal(isOptixInvoicePaidEvent("invoice_updated"), false);
  assert.equal(isOptixPurchaseEvent(""), false);
  assert.equal(isOptixInvoicePaidEvent(""), false);
});

test("a product sale is normalised from its real field names", () => {
  const purchase = normalizeOptixPurchaseEvent(newSale);
  assert.equal(purchase.eventType, "new_sale");
  // product_sale_id, not the invoice it happens to sit on.
  assert.equal(purchase.purchaseId, "102024");
  assert.equal(purchase.invoiceId, "298448");
  // The product itself, not invoice_item_name ("Sale of X (#102024)") and not
  // description ("Product sale"), both of which say nothing useful.
  assert.equal(purchase.itemName, "10 Lesson Pass");
  assert.equal(purchase.memberName, "Richard Johnson");
  assert.equal(purchase.quantity, 1);
  // total, so tax is included — 450.00 + 67.50.
  assert.equal(purchase.amountCents, 51_750);
  assert.equal(purchase.purchasedAt, "2026-08-13T04:00:00.000Z");
});

test("a product sale carries no email, so it cannot be auto-linked", () => {
  // This is the limitation, asserted so it is not mistaken for a bug later:
  // Optix identifies the buyer of a sale by display name only.
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

test("a sale naming a Pass classifies as a Pass", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent(newSale)), "pass");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "5x Range Pass" })), "pass");
  // Case does not matter, and the wording may only be in the invoice line.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "Ten pack", invoice_item_name: "Sale of Ten pack (pass)" })), "pass");
});

test("a plan is never a Pass, whatever it is called", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent(newPlanSubscription)), "not_pass");
  // A plan recurs by definition, so even this wording cannot make it a Pass.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_plan_subscription", plan_template_name: "Coaching Pass" })), "not_pass");
});

test("a sale we cannot call is kept as unknown, never silently dropped", () => {
  // The case that matters: if a Pass is named without the word, it has to stay
  // visible so the classifier can be corrected against it.
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "10 Lesson Bundle" })), "unknown");
});

test("'pass' inside another word does not count as a Pass", () => {
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "Compass Golf Club" })), "unknown");
  assert.equal(classifyPassPurchase(normalizeOptixPurchaseEvent({ event: "new_sale", product: "Passenger seat hire" })), "unknown");
});

test("an invoice_paid payload holds nothing worth recording as a purchase", () => {
  // Documents why invoice_paid no longer creates a row: the normaliser finds
  // no product, no buyer and no amount in it, because none are sent.
  const purchase = normalizeOptixPurchaseEvent(invoicePaid);
  assert.equal(purchase.itemName, "");
  assert.equal(purchase.memberName, "");
  assert.equal(purchase.memberEmail, "");
  assert.equal(purchase.amountCents, null);
  // The invoice id is the one useful thing, and it joins to the sale.
  assert.equal(purchase.invoiceId, "298448");
  assert.equal(purchase.invoiceId, normalizeOptixPurchaseEvent(newSale).invoiceId);
});

test("a sale with no usable time still records, defaulting at the caller", () => {
  const purchase = normalizeOptixPurchaseEvent({ event: "new_sale", product: "Pass" });
  assert.equal(purchase.purchasedAt, "");
  assert.equal(purchase.amountCents, null);
  assert.equal(purchase.quantity, null);
});
