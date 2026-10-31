import assert from "node:assert/strict";
import test from "node:test";

import { addToCart, cartCount, cartKey, parseCart, setCartQuantity } from "./siteCart";

test("a stored cart is read back cleaned, and anything unreadable is an empty cart", () => {
  assert.deepEqual(parseCart('[{"itemId":"glove","variantId":"l","quantity":2},{"itemId":"","quantity":1},{"itemId":"book","quantity":0},{"itemId":"hat","quantity":99}]'), [
    { itemId: "glove", variantId: "l", quantity: 2 },
    { itemId: "hat", variantId: "", quantity: 20 },
  ]);
  assert.deepEqual(parseCart("nope"), []);
  assert.deepEqual(parseCart(null), []);
  assert.equal(cartKey("riverside"), "clarity-cart:riverside");
});

test("adding the same thing in the same option grows its line; a different option is a new line", () => {
  let cart = addToCart([], "glove", "s");
  cart = addToCart(cart, "glove", "s");
  cart = addToCart(cart, "glove", "l");
  assert.deepEqual(cart, [
    { itemId: "glove", variantId: "s", quantity: 2 },
    { itemId: "glove", variantId: "l", quantity: 1 },
  ]);
  assert.equal(cartCount(cart), 3);
  assert.deepEqual(setCartQuantity(cart, 0, 0), [{ itemId: "glove", variantId: "l", quantity: 1 }], "zero removes the line");
  assert.equal(setCartQuantity(cart, 1, 50)[1].quantity, 20, "a line is capped");
});

test("a cart holds a bounded number of lines", () => {
  let cart = addToCart([], "a", "");
  for (let index = 0; index < 30; index += 1) cart = addToCart(cart, `item-${index}`, "");
  assert.equal(cart.length, 20);
});
