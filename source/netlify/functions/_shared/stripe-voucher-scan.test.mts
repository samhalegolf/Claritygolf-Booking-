/**
 * Reading a Stripe charge for the name of what was sold.
 *
 * The charges these run against are real in shape: every Squarespace sale in
 * this account arrives with `description: "Charge for <email>"` and whatever
 * Squarespace chose to put in metadata. So the cases worth testing are the
 * ones that decide whether the screen finds anything at all -- the filler
 * description being ignored, a metadata value under an unknown key being
 * found -- and the one that decides whether it lies: a refunded purchase.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  chargeIsClaimable,
  chargeValueCents,
  chargeWording,
  voucherVerdict,
} from "./stripe-voucher-scan.mts";

const squarespaceCharge = (metadata: Record<string, string>, over: Record<string, unknown> = {}) => ({
  id: "ch_test",
  status: "succeeded",
  amount: 15000,
  amount_refunded: 0,
  description: "Charge for buyer@example.com",
  metadata: { orderId: "272", ...metadata },
  ...over,
});

test("Stripe's filler description is never offered as a product name", () => {
  // Every charge in the account has this and it says nothing. If it counted,
  // the candidate list would be 102 identical rows.
  const found = chargeWording(squarespaceCharge({}));
  assert.equal(
    found.some((entry) => /^charge for/i.test(entry.text)),
    false,
  );
});

test("the order number is not mistaken for a product name", () => {
  const found = chargeWording(squarespaceCharge({}));
  assert.deepEqual(found, [], "an order id alone is not wording");
});

test("a voucher named in metadata is found whatever the key is called", () => {
  // The point of scanning every value: Squarespace's key name is its business
  // and naming one here is how the old importer ended up finding nothing.
  for (const key of ["itemName", "product", "line_item_1", "sqsp_item"]) {
    const verdict = voucherVerdict(squarespaceCharge({ [key]: "Lesson Gift Voucher" }));
    assert.equal(verdict.likely, true, `${key} should have been read`);
    assert.equal(verdict.label, "Lesson Gift Voucher");
    assert.equal(verdict.labelSource, `charge.${key}`, "the coach is shown where it came from");
  }
});

test("a voucher named on the payment intent is found too", () => {
  const verdict = voucherVerdict(
    squarespaceCharge({}, {
      payment_intent: { description: "1 Hour Golf Lesson Voucher", metadata: {} },
    }),
  );
  assert.equal(verdict.likely, true);
  assert.equal(verdict.labelSource, "payment intent");
});

test("a lesson sold online is not a voucher", () => {
  // These are the bulk of the account's charges and minting a code for one
  // would hand out a second entitlement for a lesson already paid for.
  const verdict = voucherVerdict(squarespaceCharge({ itemName: "1 Hour Lesson - Roy Godwin" }));
  assert.equal(verdict.likely, false);
  assert.equal(verdict.label, "1 Hour Lesson - Roy Godwin", "still shown, just not claimed");
});

test("a charge with no wording at all is reported as such, not dropped", () => {
  const verdict = voucherVerdict(squarespaceCharge({}));
  assert.deepEqual(verdict, { label: "", labelSource: "", likely: false });
});

test("a fully refunded purchase is never claimable", () => {
  // Minting a code for money that went back is the one mistake here that
  // costs real value and cannot be spotted from the coupon afterwards.
  assert.equal(
    chargeIsClaimable(squarespaceCharge({}, { amount_refunded: 15000 })),
    false,
  );
  assert.equal(chargeIsClaimable(squarespaceCharge({}, { status: "failed" })), false);
  assert.equal(chargeIsClaimable(squarespaceCharge({})), true);
});

test("a partly refunded voucher is worth what is left", () => {
  assert.equal(chargeValueCents(squarespaceCharge({}, { amount_refunded: 5000 })), 10000);
  assert.equal(chargeIsClaimable(squarespaceCharge({}, { amount_refunded: 5000 })), true);
});

test("the captured amount wins over the authorised one", () => {
  assert.equal(
    chargeValueCents(squarespaceCharge({}, { amount: 15000, amount_captured: 12000 })),
    12000,
  );
});
