// Keeping Tap to Pay connected in the background.
//
// Two things must hold. A phone that was never set up is left alone, because
// its first connection is when Apple shows its terms and that has to be the
// coach's choice. And connections never overlap: the plugin can only look for
// one reader at a time, and the background, Settings and a sale can all ask
// at once.
//
// Its own file because the availability check is cached per page load.

import assert from "node:assert/strict";
import test from "node:test";

const stored = new Map<string, string>();
const listeners = new Map<string, () => void>();
const prepares: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  },
  document: {
    visibilityState: "visible",
    addEventListener: (event: string, handler: () => void) => void listeners.set(event, handler),
    removeEventListener: (event: string) => void listeners.delete(event),
  },
  fetch: async (url: string) => {
    const body = url.endsWith("/status")
      ? { available: true, testMode: true, reason: "", locations: [{ id: "loc-1", name: "Bay", isDefault: true }] }
      : { stripeLocationId: "tml_1", name: "Bay", testMode: true };
    return new Response(JSON.stringify(body), { status: 200 });
  },
  Capacitor: {
    isNativePlatform: () => true,
    isPluginAvailable: () => true,
    Plugins: {
      ClarityTerminal: {
        isSupported: async () => ({ supported: true, reason: "" }),
        prepare: async ({ stripeLocationId }: { stripeLocationId: string }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          prepares.push(stripeLocationId);
          inFlight -= 1;
          return { connected: true };
        },
        addListener: () => ({ remove: () => undefined }),
      },
    },
  },
});

const { connectThisPhone, keepTapToPayWarm } = await import("./terminal");
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

test("a phone never set up is not connected behind the coach's back", async () => {
  const stop = keepTapToPayWarm();
  await settle();
  assert.deepEqual(prepares, []);
  stop();
});

test("once set up, it connects on open and again on coming back to the app", async () => {
  await connectThisPhone("loc-1");
  prepares.length = 0;
  const stop = keepTapToPayWarm();
  await settle();
  assert.equal(prepares.length, 1);
  listeners.get("visibilitychange")?.();
  await settle();
  assert.equal(prepares.length, 2);
  stop();
  assert.equal(listeners.has("visibilitychange"), false);
});

test("connections asked for together run one at a time", async () => {
  maxInFlight = 0;
  await Promise.all([connectThisPhone("loc-1"), connectThisPhone("loc-1"), connectThisPhone("loc-1")]);
  assert.equal(maxInFlight, 1);
});
