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
  cleanVariants,
  onlineBuyerPersonId,
  onlineShopItems,
  onlineShopSwitchedOn,
  orderLineName,
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
      { ...voucherRow, id: "glove", is_voucher: false, sell_online: false },
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

const gloveRow = {
  id: "prod-glove",
  name: "Players glove",
  default_price: 40,
  active: true,
  is_voucher: false,
  sell_online: true,
  fulfilment: "ship",
  image_url: "https://cdn.example/glove.jpg",
  track_stock: true,
  stock_level: 3,
  variants: JSON.stringify([
    { id: "s", name: "Small", price: null },
    { id: "l", name: "Large", price: 45 },
  ]),
};
const bookRow = { id: "prod-book", name: "The book (PDF)", default_price: 15, active: true, sell_online: true, fulfilment: "download", track_stock: false, variants: "[]" };

test("a product is on the shelf once ticked for the website, priced from its cheapest option, with its stock", () => {
  const items = onlineShopItems([], [gloveRow, bookRow, { ...gloveRow, id: "shelf-only", sell_online: false }, { ...gloveRow, id: "retired", active: false }], "NZD");
  assert.deepEqual(
    items.map((item) => [item.id, item.kind, item.price, item.fulfilment, item.stock, item.variants.length]),
    [
      ["prod-glove", "product", 40, "ship", 3, 2],
      ["prod-book", "product", 15, "download", null, 0],
    ],
  );
  assert.equal(items[0].image, "https://cdn.example/glove.jpg");
});

test("variants are a list of named choices; a bad entry is dropped and a price must be a number", () => {
  assert.deepEqual(cleanVariants('[{"name":"Small"},{"name":"Large","price":"45"},{"name":""},{"id":"x","name":"Odd","price":-1}]'), [
    { id: "v1", name: "Small", price: null },
    { id: "v2", name: "Large", price: 45 },
    { id: "x", name: "Odd", price: null },
  ]);
  assert.deepEqual(cleanVariants("not json"), []);
  assert.deepEqual(cleanVariants([{ id: "a", name: "One" }, { id: "a", name: "Twice" }]), [{ id: "a", name: "One", price: null }]);
});

const shelf = onlineShopItems([lesson, fivePack], [voucherRow, gloveRow, bookRow], "NZD");
const buyer = { name: "Sam", email: "sam@example.com" };

test("an order must name things on the shelf, a name and a usable email", () => {
  const base = { ...buyer, lines: [{ itemId: "prod-voucher", quantity: 1 }] };
  assert.deepEqual(readOnlineOrder({ ...base, lines: [{ itemId: `${LESSON_ITEM_PREFIX}svc-lesson` }] }, shelf), { error: "Something in the order is no longer for sale." });
  assert.deepEqual(readOnlineOrder({ ...base, lines: [] }, shelf), { error: "Nothing is in the order." });
  assert.ok("error" in readOnlineOrder({ ...base, name: " " }, shelf));
  assert.ok("error" in readOnlineOrder({ ...base, email: "not-an-email" }, shelf));
  assert.ok(!("error" in readOnlineOrder(base, shelf)));
});

test("the browser names the item and its option, never a price", () => {
  const read = readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-voucher", quantity: 1, unitPrice: 1 }, { itemId: "prod-glove", variantId: "l", quantity: 2, price: 1 }] }, shelf);
  assert.ok(!("error" in read));
  if ("error" in read) return;
  assert.deepEqual(read.order.lines.map((line) => [line.itemId, line.variant?.id ?? "", line.quantity, line.unitPrice]), [
    ["prod-voucher", "", 1, 160],
    ["prod-glove", "l", 2, 45],
  ]);
  assert.equal(read.order.itemsTotal, 250);
  assert.equal(orderLineName(read.order.lines[1]), "Players glove - Large");
});

test("a product with options needs one chosen, and the shelf caps what can be ordered", () => {
  assert.deepEqual(readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-glove", quantity: 1 }] }, shelf), { error: "Choose an option for Players glove." });
  assert.deepEqual(readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-glove", variantId: "s", quantity: 4 }] }, shelf), { error: "Only 3 of Players glove left." });
  assert.deepEqual(
    readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-glove", variantId: "s", quantity: 2 }, { itemId: "prod-glove", variantId: "l", quantity: 2 }] }, shelf),
    { error: "Only 3 of Players glove left." },
    "two sizes of one product share its shelf",
  );
  const soldOut = onlineShopItems([], [{ ...gloveRow, stock_level: 0 }], "NZD");
  assert.equal(soldOut[0].stock, 0, "a sold-out product stays listed");
  assert.deepEqual(readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-glove", variantId: "s", quantity: 1 }] }, soldOut), { error: "Players glove is sold out." });
  assert.ok("error" in readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-book", quantity: 21 }] }, shelf));
  assert.ok(!("error" in readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-book", quantity: 20 }] }, shelf)), "a book has no shelf to run out of");
});

test("shipping is charged once, only when something in the order is posted", () => {
  const posted = readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-glove", variantId: "s", quantity: 2 }, { itemId: "prod-book", quantity: 1 }] }, shelf, 8.5);
  const emailed = readOnlineOrder({ ...buyer, lines: [{ itemId: "prod-book", quantity: 1 }, { itemId: "prod-voucher", quantity: 1 }] }, shelf, 8.5);
  assert.ok(!("error" in posted) && !("error" in emailed));
  if ("error" in posted || "error" in emailed) return;
  assert.deepEqual([posted.order.needsShipping, posted.order.shipping, posted.order.total], [true, 8.5, 103.5]);
  assert.deepEqual([emailed.order.needsShipping, emailed.order.shipping, emailed.order.total], [false, 0, 175]);
});

test("a gift's recipient and message ride on an order with a voucher and are dropped from one without", () => {
  const gift = { name: "Sam", email: "Sam@Example.com", recipientName: "Alex", message: "Happy birthday" };
  const voucher = readOnlineOrder({ ...gift, lines: [{ itemId: "prod-voucher" }] }, shelf);
  const pack = readOnlineOrder({ ...gift, lines: [{ itemId: `${LESSON_ITEM_PREFIX}svc-five` }] }, shelf);
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
