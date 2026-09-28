/**
 * Taking money from a customer, which this app had never done before.
 *
 * Two things here are worth a test and the rest is plumbing:
 *
 *   1. Which Stripe account the money lands in. Getting this wrong for the
 *      second business to sign up means their customers' payments arrive in
 *      someone else's account, and nothing in the app would look broken.
 *   2. Clarity Pay's cut, and what each route may charge for. Clarity Pay
 *      payments carry the fee, own-Stripe ones never do, and the fee must
 *      never be the whole payment -- Stripe refuses that, and the sale fails.
 *   3. What is on the shelf. The shop is priced from the catalogue on the
 *      server, so anything wrongly on it is something a player can be charged
 *      for -- and anything wrongly priced at zero is a card form that charges
 *      nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { checkoutSourceRef, findPlayerShopItem, playerShopItems } from "./player-shop.mts";
import {
  applicationFeeCents,
  clarityPayFeeCents,
  createStripeCheckoutSession,
  parseStripeConnection,
  requireStripeFeature,
  resolveStripeCredential,
  stripeCredentialStatus,
  stripeHeaders,
} from "./stripe.mts";

/* --- Whose Stripe ------------------------------------------------------- */

const LIVE_PLATFORM = "sk_live_platformkey000000";
const TEST_PLATFORM = "sk_test_platformkey000000";
const LIVE = JSON.stringify({ account: "acct_coachlive1", livemode: true });
const TEST = JSON.stringify({ account: "acct_coachtest1", livemode: false });
const CLARITY_PAY = JSON.stringify({ account: "acct_claritypay1", livemode: true, route: "clarity_pay" });

function withPlatformKeys(keys: { live?: string; test?: string }, run: () => void) {
  const before = {
    live: process.env.STRIPE_PLATFORM_SECRET_KEY,
    test: process.env.STRIPE_PLATFORM_TEST_SECRET_KEY,
  };
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set("STRIPE_PLATFORM_SECRET_KEY", keys.live);
  set("STRIPE_PLATFORM_TEST_SECRET_KEY", keys.test);
  try {
    run();
  } finally {
    set("STRIPE_PLATFORM_SECRET_KEY", before.live);
    set("STRIPE_PLATFORM_TEST_SECRET_KEY", before.test);
  }
}

test("a connected business is charged on its own Stripe account", () => {
  // The whole multi-tenant question: every request names the business's
  // account, so the money lands there and nowhere else.
  withPlatformKeys({ live: LIVE_PLATFORM, test: TEST_PLATFORM }, () => {
    const credential = resolveStripeCredential(LIVE);
    assert.equal(credential.account, "acct_coachlive1");
    assert.equal(credential.secret, LIVE_PLATFORM);
    assert.deepEqual(stripeHeaders(credential), {
      Authorization: `Bearer ${LIVE_PLATFORM}`,
      "Stripe-Account": "acct_coachlive1",
    });
  });
});

test("a test-mode connection is served by the test key and takes no real money", () => {
  withPlatformKeys({ live: LIVE_PLATFORM, test: TEST_PLATFORM }, () => {
    assert.equal(resolveStripeCredential(TEST).secret, TEST_PLATFORM);
    assert.equal(stripeCredentialStatus(TEST).testMode, true);
    assert.equal(stripeCredentialStatus(LIVE).testMode, false);
  });
});

test("a business that has not connected cannot take a payment", () => {
  withPlatformKeys({ live: LIVE_PLATFORM }, () => {
    for (const value of ["", " \n\t ", "sk_live_pastedkey1234", "{}", '{"account":"not-an-account"}']) {
      assert.throws(() => resolveStripeCredential(value), (error: { status?: number; code?: string }) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, "STRIPE_NOT_CONFIGURED");
        return true;
      });
      const status = stripeCredentialStatus(value);
      assert.equal(status.configured, false);
      assert.equal(status.account, "");
      assert.equal(status.route, "");
      assert.deepEqual(status.features, { invoices: false, till: false, portal: false });
    }
  });
});

test("a connection is not usable until Clarity's platform key for its mode is set", () => {
  withPlatformKeys({ live: LIVE_PLATFORM }, () => {
    assert.throws(() => resolveStripeCredential(TEST), (error: { code?: string }) => error.code === "STRIPE_PLATFORM_NOT_CONFIGURED");
    const status = stripeCredentialStatus(TEST);
    assert.equal(status.configured, false);
    assert.equal(status.account, "acct_coachtest1", "still shown, so the screen can say what is connected");
  });
});

test("only a real connected account id is accepted", () => {
  assert.deepEqual(parseStripeConnection(LIVE), { account: "acct_coachlive1", livemode: true, route: "own_stripe" });
  assert.deepEqual(parseStripeConnection({ account: "acct_x1", livemode: "yes" }), {
    account: "acct_x1",
    livemode: false,
    route: "own_stripe",
  });
  assert.equal(parseStripeConnection("not json"), null);
  assert.equal(parseStripeConnection({ account: "acct_; DROP" }), null);
});

/* --- Clarity Pay's cut -------------------------------------------------- */

test("Clarity Pay takes its percentage plus any flat fee, rounded to the cent", () => {
  assert.equal(clarityPayFeeCents(10000, { percent: 1, fixedCents: 0 }), 100);
  assert.equal(clarityPayFeeCents(1250, { percent: 1, fixedCents: 0 }), 13);
  assert.equal(clarityPayFeeCents(10000, { percent: 0.5, fixedCents: 10 }), 60);
});

test("Clarity Pay's cut is never the whole payment", () => {
  // Stripe refuses an application fee that is not less than the charge.
  assert.equal(clarityPayFeeCents(50, { percent: 1, fixedCents: 100 }), 49);
  assert.equal(clarityPayFeeCents(1, { percent: 50, fixedCents: 0 }), 0);
});

test("a zero fee sends no application fee at all", () => {
  assert.equal(clarityPayFeeCents(10000, { percent: 0, fixedCents: 0 }), 0);
});

test("the default cut is half a percent", () => {
  assert.equal(clarityPayFeeCents(10000), 50);
});

async function checkoutParams(route: "clarity_pay" | "own_stripe") {
  const realFetch = globalThis.fetch;
  let sent = new URLSearchParams();
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
  }) as typeof fetch;
  try {
    await createStripeCheckoutSession(
      { secret: TEST_PLATFORM, account: "acct_coachtest1", livemode: false, route },
      { amount: 80, currency: "NZD", productName: "Lesson", successUrl: "https://x/ok", cancelUrl: "https://x/no" },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test("a Clarity Pay checkout carries Clarity's cut as the application fee", async () => {
  const sent = await checkoutParams("clarity_pay");
  assert.equal(sent.get("line_items[0][price_data][unit_amount]"), "8000");
  assert.equal(sent.get("payment_intent_data[application_fee_amount]"), String(clarityPayFeeCents(8000)));
});

test("an own-Stripe checkout pays Clarity nothing", async () => {
  const sent = await checkoutParams("own_stripe");
  assert.equal(sent.get("payment_intent_data[application_fee_amount]"), null);
  assert.equal(applicationFeeCents({ secret: "", account: "acct_x1", livemode: true, route: "own_stripe" }, 8000), 0);
});

/* --- What each route can charge for ------------------------------------- */

test("Clarity Pay takes cards everywhere", () => {
  withPlatformKeys({ live: LIVE_PLATFORM }, () => {
    const credential = resolveStripeCredential(CLARITY_PAY);
    assert.equal(credential.route, "clarity_pay");
    for (const feature of ["invoices", "till", "portal"] as const) requireStripeFeature(credential, feature);
    assert.deepEqual(stripeCredentialStatus(CLARITY_PAY).features, { invoices: true, till: true, portal: true });
  });
});

test("an own-Stripe business takes invoice payments only", () => {
  withPlatformKeys({ live: LIVE_PLATFORM }, () => {
    // LIVE predates routes, so it reads as a Stripe sign-in.
    const credential = resolveStripeCredential(LIVE);
    assert.equal(credential.route, "own_stripe");
    requireStripeFeature(credential, "invoices");
    for (const feature of ["till", "portal"] as const) {
      assert.throws(() => requireStripeFeature(credential, feature), (error: { code?: string }) => error.code === "CLARITY_PAY_REQUIRED");
    }
  });
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
