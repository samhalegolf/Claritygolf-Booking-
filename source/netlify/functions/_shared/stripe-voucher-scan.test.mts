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
  checkoutLineItemWording,
  mapLimit,
  squarespaceOrderId,
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

/* --- The basket -----------------------------------------------------------
 *
 * The last place a product name can be, and for this account the only one:
 * every Squarespace charge says "Charge for <email>" and carries nothing but
 * an order id. If reading the Checkout Session's line items does not work,
 * the voucher screen has nothing to show.
 */

/** A fake Stripe that answers the two calls the lookup makes. */
function fakeStripe(
  responses: Record<string, unknown>,
  seen: Array<{ path: string; params: string }> = [],
) {
  return {
    seen,
    get: async (path: string, params: URLSearchParams) => {
      seen.push({ path, params: params.toString() });
      if (path in responses) return responses[path];
      throw Object.assign(new Error(`unexpected ${path}`), { status: 404 });
    },
  };
}

test("a basket line is found through the payment intent", async () => {
  const stripe = fakeStripe({
    "checkout/sessions": { data: [{ id: "cs_1" }] },
    "checkout/sessions/cs_1/line_items": { data: [{ description: "Lesson Gift Voucher" }] },
  });
  const found = await checkoutLineItemWording(
    { id: "ch_1", payment_intent: "pi_1" },
    stripe.get,
  );
  assert.deepEqual(found, [{ text: "Lesson Gift Voucher", source: "basket" }]);
  assert.equal(stripe.seen[0].params, "payment_intent=pi_1&limit=1", "sessions are found by intent");
});

test("an expanded payment intent object still resolves to its id", async () => {
  // The backfill asks for expand[]=data.payment_intent, so by the time this
  // runs the field is an object. Reading it as a string would send
  // "[object Object]" to Stripe and quietly find nothing.
  const stripe = fakeStripe({
    "checkout/sessions": { data: [{ id: "cs_1" }] },
    "checkout/sessions/cs_1/line_items": { data: [{ description: "Lesson Gift Voucher" }] },
  });
  const found = await checkoutLineItemWording(
    { id: "ch_1", payment_intent: { id: "pi_1", description: null } },
    stripe.get,
  );
  assert.equal(found[0]?.text, "Lesson Gift Voucher");
  assert.equal(stripe.seen[0].params, "payment_intent=pi_1&limit=1");
});

test("a charge with no session is simply nameless, not an error", async () => {
  const stripe = fakeStripe({ "checkout/sessions": { data: [] } });
  assert.deepEqual(await checkoutLineItemWording({ id: "ch_1", payment_intent: "pi_1" }, stripe.get), []);
});

test("a Stripe failure never escapes the lookup", async () => {
  // One unreadable session must not abandon a sync of three hundred charges.
  const failing = async () => {
    throw new Error("Stripe 500");
  };
  assert.deepEqual(await checkoutLineItemWording({ id: "ch_1", payment_intent: "pi_1" }, failing), []);
});

test("a charge with no payment intent is not looked up at all", async () => {
  const stripe = fakeStripe({});
  assert.deepEqual(await checkoutLineItemWording({ id: "ch_1" }, stripe.get), []);
  assert.equal(stripe.seen.length, 0, "no request should have been made");
});

test("a basket name is judged for voucher wording like any other", async () => {
  const basket = [{ text: "Lesson Gift Voucher", source: "basket" }];
  const verdict = voucherVerdict(
    { id: "ch_1", description: "Charge for buyer@example.com", metadata: { orderId: "272" } },
    basket,
  );
  assert.equal(verdict.likely, true);
  assert.equal(verdict.label, "Lesson Gift Voucher");
  assert.equal(verdict.labelSource, "basket");
});

test("the charge's own wording still beats the basket's", async () => {
  // A description somebody wrote about this sale is more specific than the
  // catalogue's name for the product in general.
  const verdict = voucherVerdict(
    { id: "ch_1", description: "Gift voucher for Dad — Christmas", metadata: {} },
    [{ text: "Lesson Gift Voucher", source: "basket" }],
  );
  assert.equal(verdict.label, "Gift voucher for Dad — Christmas");
});

test("mapLimit runs everything, in order, a few at a time", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14], "results keep their input order");
  assert.ok(peak <= 3, `concurrency was ${peak}, should never exceed 3`);
});

test("mapLimit on an empty list does nothing and returns nothing", async () => {
  assert.deepEqual(await mapLimit([], 6, async () => 1), []);
});

/* --- Identifiers are not product names ------------------------------------
 *
 * Squarespace's real metadata, read off a live payment on 2026-09-17, is four
 * identifiers and nothing else. Offering one of them as the name of what was
 * sold is worse than saying the charge is nameless: a coach cannot tell a hex
 * string that means nothing from a product code that means something.
 */

const REAL_SQUARESPACE_METADATA = {
  id: "6a97b4afc2292557d4837052",
  idempotencyKey: "3e4385ca-d62f-4f4f-8193-bc135ccca0ff",
  orderId: "272",
  websiteId: "60fc8fda6e7e057270d8ddbf",
};

test("the real Squarespace metadata yields no product name at all", () => {
  const verdict = voucherVerdict({
    id: "ch_1",
    description: "Charge for harrisontapleyking@gmail.com",
    metadata: REAL_SQUARESPACE_METADATA,
  });
  assert.deepEqual(
    verdict,
    { label: "", labelSource: "", likely: false },
    "an identifier must never be presented as the thing that was bought",
  );
});

test("an identifier is rejected by its shape, not only by its key name", () => {
  // A provider that calls the field something else must not slip through.
  for (const value of [
    "6a97b4afc2292557d4837052",
    "3e4385ca-d62f-4f4f-8193-bc135ccca0ff",
    "272",
    "abcdefghijklmnopqrstuvwxyz0123",
  ]) {
    assert.deepEqual(
      chargeWording({ id: "ch_1", metadata: { sqsp_thing: value } }),
      [],
      `${value} should not read as a product name`,
    );
  }
});

test("a real product name is still read from a key that ends in nothing special", () => {
  // The filter must not be so keen that it throws away the thing we are for.
  assert.equal(
    voucherVerdict({ id: "ch_1", metadata: { item: "Lesson Gift Voucher" } }).label,
    "Lesson Gift Voucher",
  );
  assert.equal(
    voucherVerdict({ id: "ch_1", metadata: { sqsp_product: "1 Hour Golf Lesson Voucher" } }).label,
    "1 Hour Golf Lesson Voucher",
  );
});

test("the Squarespace order number is readable from either place it lands", () => {
  // The join key for the Orders API lookup that will replace price rules.
  // Read from the charge or, once the intent is expanded, from the intent.
  assert.equal(squarespaceOrderId({ metadata: { orderId: "272" } }), "272");
  assert.equal(
    squarespaceOrderId({ metadata: {}, payment_intent: { id: "pi_1", metadata: { orderId: "272" } } }),
    "272",
  );
  assert.equal(squarespaceOrderId({ metadata: {} }), "");
});
