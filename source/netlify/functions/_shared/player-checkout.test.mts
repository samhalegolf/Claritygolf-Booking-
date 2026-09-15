/**
 * Taking money from a customer, which this app had never done before.
 *
 * Two things here are worth a test and the rest is plumbing:
 *
 *   1. Which Stripe account the money lands in. Getting this wrong for the
 *      second business to sign up means their customers' payments arrive in
 *      the first one's bank account, and nothing in the app would look broken.
 *   2. What is on the shelf. The shop is priced from the catalogue on the
 *      server, so anything wrongly on it is something a player can be charged
 *      for -- and anything wrongly priced at zero is a card form that charges
 *      nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkoutSourceRef, findPlayerShopItem, playerShopItems } from "./player-shop.mts";
import {
  isStripeSecretShaped,
  isStripeTestKey,
  maskStripeSecret,
  resolveStripeCredential,
  stripeCredentialStatus,
} from "./stripe.mts";

/* --- Whose Stripe ------------------------------------------------------- */

const PLATFORM = "sk_live_platformkey000000";
const OWN = "sk_live_coachownkey11111";

function withPlatformKey(value: string | undefined, run: () => void) {
  const before = process.env.STRIPE_SECRET_KEY;
  if (value === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = before;
  }
}

test("a business with its own key is charged on its own key", () => {
  // The whole multi-tenant question in one assertion: the platform key exists
  // and must still lose to the account's own.
  withPlatformKey(PLATFORM, () => {
    const credential = resolveStripeCredential(OWN);
    assert.equal(credential.secret, OWN);
    assert.equal(credential.mode, "account");
  });
});

test("a business with no key of its own falls back to the platform", () => {
  withPlatformKey(PLATFORM, () => {
    const credential = resolveStripeCredential("");
    assert.equal(credential.secret, PLATFORM);
    assert.equal(credential.mode, "platform");
  });
});

test("whitespace is not a key", () => {
  // A pasted key with a trailing newline must not read as "configured" and
  // then silently take the platform's money instead.
  withPlatformKey(PLATFORM, () => {
    assert.equal(resolveStripeCredential(" \n\t ").mode, "platform");
  });
  withPlatformKey(undefined, () => {
    assert.equal(stripeCredentialStatus("  ").configured, false);
  });
});

test("no key anywhere refuses rather than charging nobody", () => {
  withPlatformKey(undefined, () => {
    assert.throws(() => resolveStripeCredential(""), (error: { status?: number; code?: string }) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "STRIPE_NOT_CONFIGURED");
      return true;
    });
    assert.equal(stripeCredentialStatus("").configured, false);
    assert.equal(stripeCredentialStatus("").mode, "none");
  });
});

test("the status a UI is given never carries the key", () => {
  withPlatformKey(PLATFORM, () => {
    const own = stripeCredentialStatus(OWN);
    assert.equal(JSON.stringify(own).includes(OWN), false);
    assert.equal(own.maskedTail, "••••1111");

    // The platform's key is not this coach's to see any part of.
    const platform = stripeCredentialStatus("");
    assert.equal(platform.maskedTail, "");
    assert.equal(JSON.stringify(platform).includes(PLATFORM), false);
  });
});

test("a test key is reported as one, because it takes no real money", () => {
  withPlatformKey(undefined, () => {
    assert.equal(stripeCredentialStatus("sk_test_abcdefgh1234").testMode, true);
    assert.equal(stripeCredentialStatus(OWN).testMode, false);
  });
  assert.equal(isStripeTestKey("rk_test_abcdefgh1234"), true);
});

test("a publishable key is refused before it is ever stored", () => {
  // The mistake worth catching: pk_ is the key on the coach's own screen, and
  // it is the one they will paste first.
  assert.equal(isStripeSecretShaped("pk_live_abcdefgh1234"), false);
  assert.equal(isStripeSecretShaped("sk_live_abcdefgh1234"), true);
  assert.equal(isStripeSecretShaped("rk_live_abcdefgh1234"), true, "restricted keys are the safer choice");
  assert.equal(isStripeSecretShaped("sk_live_"), false);
  assert.equal(isStripeSecretShaped(""), false);
  assert.equal(isStripeSecretShaped(undefined), false);
});

test("masking keeps four characters and no more", () => {
  assert.equal(maskStripeSecret("sk_live_abcd1234"), "••••1234");
  assert.equal(maskStripeSecret("abc"), "");
});

/* --- What is on the shelf ----------------------------------------------- */

const service = (over: Record<string, unknown> = {}) => ({
  id: "svc-1",
  name: "Video Review",
  lessonFormat: "video-review",
  price: 15,
  active: true,
  ...over,
});

test("a video review sells as one credit covering itself", () => {
  const [item] = playerShopItems([service()], "NZD");
  assert.equal(item.kind, "video-review");
  assert.equal(item.credits, 1);
  assert.deepEqual(item.coversServiceIds, ["svc-1"]);
  assert.equal(item.price, 15);
  assert.equal(item.currency, "NZD");
});

test("a package sells its allowance and its own coverage", () => {
  const [item] = playerShopItems(
    [
      service({
        id: "pkg-5",
        name: "5 Lesson Package",
        lessonFormat: "package",
        price: 400,
        packageAllowance: 5,
        packageCoversServiceId: "lesson-60",
      }),
    ],
    "NZD",
  );
  assert.equal(item.credits, 5);
  assert.deepEqual(item.coversServiceIds, ["lesson-60"]);
});

test("an ordinary lesson is not for sale", () => {
  // A lesson is a slot with a coach and a room. Selling it as a credit would
  // let a player pay for availability that does not exist.
  assert.deepEqual(playerShopItems([service({ lessonFormat: "private" })], "NZD"), []);
  assert.deepEqual(playerShopItems([service({ lessonFormat: "group" })], "NZD"), []);
});

test("nothing free or inactive reaches the shelf", () => {
  assert.deepEqual(playerShopItems([service({ active: false })], "NZD"), []);
  assert.deepEqual(playerShopItems([service({ price: 0 })], "NZD"), []);
  assert.deepEqual(playerShopItems([service({ priceMode: "free" })], "NZD"), []);
  assert.deepEqual(playerShopItems([service({ price: -5 })], "NZD"), []);
});

test("a package covering nothing is not sold", () => {
  // It would take money for a credit with nowhere to spend it.
  assert.deepEqual(
    playerShopItems(
      [service({ lessonFormat: "package", price: 100, packageAllowance: 5 })],
      "NZD",
    ),
    [],
  );
});

test("the cheapest thing is listed first", () => {
  const items = playerShopItems(
    [
      service({ id: "pkg", lessonFormat: "package", name: "Package", price: 400, packageAllowance: 5, packageCoversServiceId: "l" }),
      service({ id: "rev", price: 15 }),
    ],
    "NZD",
  );
  assert.deepEqual(items.map((entry) => entry.serviceId), ["rev", "pkg"]);
});

test("only something on the shelf can be bought", () => {
  const items = playerShopItems([service()], "NZD");
  assert.equal(findPlayerShopItem(items, "svc-1")?.serviceId, "svc-1");
  assert.equal(findPlayerShopItem(items, "svc-2"), null);
  assert.equal(findPlayerShopItem(items, ""), null);
  assert.equal(findPlayerShopItem(items, undefined), null);
});

test("a rubbish catalogue is an empty shop, not a crash", () => {
  assert.deepEqual(playerShopItems(null, "NZD"), []);
  assert.deepEqual(playerShopItems("nonsense", "NZD"), []);
  assert.deepEqual(playerShopItems([{}, { id: "" }], "NZD"), []);
});

test("banking a purchase is keyed on the Stripe session", () => {
  // Confirming is a poll and runs repeatedly while the player comes back from
  // Stripe. The unique index on (account_id, source, source_ref) is what makes
  // that safe, and this is the ref it keys on.
  assert.equal(checkoutSourceRef("cs_test_123"), "checkout:cs_test_123");
  assert.notEqual(checkoutSourceRef("cs_test_123"), checkoutSourceRef("cs_test_124"));
});
