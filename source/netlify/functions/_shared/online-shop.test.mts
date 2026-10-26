/**
 * The public shop's shelf and order form.
 *
 * The shop takes money from strangers, so the two things worth pinning down
 * are what is on the shelf -- anything wrongly on it is something a stranger
 * can be charged for -- and what an order may say about itself. The paying
 * and settling is the till's, and is tested there.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LESSON_ITEM_PREFIX,
  onlineBuyerPersonId,
  onlineShopItems,
  onlineShopSwitchedOn,
  readOnlineOrder,
} from "./online-shop.mts";
import { createStripeCheckoutSession } from "./stripe.mts";

const lesson = { id: "svc-lesson", name: "1 Hour Lesson", price: 120, lessonFormat: "lesson" };
const fivePack = {
  id: "svc-five",
  name: "Five Lessons",
  price: 500,
  lessonFormat: "package",
  packageAllowance: 5,
  coversServiceIds: ["svc-lesson"],
};
const voucherRow = { id: "prod-voucher", name: "Lesson Gift Voucher", default_price: 160, active: true, is_voucher: true };

test("the shelf is the packages the portal sells plus the voucher products", () => {
  const items = onlineShopItems([lesson, fivePack], [voucherRow], "NZD");
  assert.deepEqual(
    items.map((item) => [item.id, item.kind, item.price, item.credits]),
    [
      [`${LESSON_ITEM_PREFIX}svc-five`, "package", 500, 5],
      ["prod-voucher", "voucher", 160, 0],
    ],
  );
});

test("a single lesson is never on the shelf: it is booked against a time, not bought as a credit", () => {
  const items = onlineShopItems([lesson], [], "NZD");
  assert.deepEqual(items, []);
});

test("an archived, inactive or free package is left off", () => {
  const items = onlineShopItems(
    [
      { ...fivePack, id: "archived", archived: true },
      { ...fivePack, id: "inactive", active: false },
      { ...fivePack, id: "free", price: 0 },
      fivePack,
    ],
    [],
    "NZD",
  );
  assert.deepEqual(items.map((item) => item.id), [`${LESSON_ITEM_PREFIX}svc-five`]);
});

test("only active, priced products ticked as vouchers are sold as vouchers", () => {
  const items = onlineShopItems(
    [],
    [
      voucherRow,
      { ...voucherRow, id: "glove", is_voucher: false },
      { ...voucherRow, id: "retired", active: false },
      { ...voucherRow, id: "zero", default_price: 0 },
    ],
    "NZD",
  );
  assert.deepEqual(items.map((item) => item.id), ["prod-voucher"]);
});

test("the switch is on only when it says so", () => {
  assert.equal(onlineShopSwitchedOn("true"), true);
  assert.equal(onlineShopSwitchedOn("false"), false);
  assert.equal(onlineShopSwitchedOn(undefined), false);
  assert.equal(onlineShopSwitchedOn("yes"), false);
});

const shelf = onlineShopItems([lesson, fivePack], [voucherRow], "NZD");

test("an order must name something on the shelf, a name and a usable email", () => {
  const base = { itemId: "prod-voucher", name: "Sam", email: "sam@example.com" };
  assert.deepEqual(readOnlineOrder({ ...base, itemId: `${LESSON_ITEM_PREFIX}svc-lesson` }, shelf), { error: "That is not for sale." });
  assert.ok("error" in readOnlineOrder({ ...base, name: " " }, shelf));
  assert.ok("error" in readOnlineOrder({ ...base, email: "not-an-email" }, shelf));
  assert.ok(!("error" in readOnlineOrder(base, shelf)));
});

test("the browser names the item, never its price", () => {
  const read = readOnlineOrder({ itemId: "prod-voucher", name: "Sam", email: "sam@example.com", price: 1 }, shelf);
  assert.ok(!("error" in read));
  if ("error" in read) return;
  assert.equal(read.item.price, 160);
});

test("a gift's recipient and message ride on a voucher and are dropped from a package", () => {
  const gift = { name: "Sam", email: "Sam@Example.com", recipientName: "Alex", message: "Happy birthday" };
  const voucher = readOnlineOrder({ ...gift, itemId: "prod-voucher" }, shelf);
  const pack = readOnlineOrder({ ...gift, itemId: `${LESSON_ITEM_PREFIX}svc-five` }, shelf);
  assert.ok(!("error" in voucher) && !("error" in pack));
  if ("error" in voucher || "error" in pack) return;
  assert.equal(voucher.order.email, "sam@example.com");
  assert.equal(voucher.order.recipientName, "Alex");
  assert.equal(voucher.order.message, "Happy birthday");
  assert.equal(pack.order.recipientName, "");
  assert.equal(pack.order.message, "");
});

test("the webhook and the return page file a new buyer under the same id", () => {
  assert.equal(onlineBuyerPersonId("abc"), onlineBuyerPersonId("abc"));
  assert.notEqual(onlineBuyerPersonId("abc"), onlineBuyerPersonId("abd"));
});

test("an online checkout closes after the time asked for, never sooner than Stripe allows", async () => {
  const realFetch = globalThis.fetch;
  const sent: URLSearchParams[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(new URLSearchParams(String(init?.body || "")));
    return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" }), { status: 200 });
  }) as typeof fetch;
  const credential = { secret: "sk_test_x", account: "acct_x", livemode: false, route: "clarity_pay" as const };
  const base = { amount: 160, currency: "NZD", productName: "Voucher", successUrl: "https://x/ok", cancelUrl: "https://x/no" };
  try {
    const before = Math.floor(Date.now() / 1000);
    await createStripeCheckoutSession(credential, { ...base, expiresInMinutes: 60 });
    await createStripeCheckoutSession(credential, { ...base, expiresInMinutes: 5 });
    await createStripeCheckoutSession(credential, base);
    const [hour, tooSoon, unset] = sent.map((params) => params.get("expires_at"));
    assert.ok(Math.abs(Number(hour) - (before + 3600)) <= 5);
    assert.ok(Math.abs(Number(tooSoon) - (before + 1800)) <= 5);
    assert.equal(unset, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
