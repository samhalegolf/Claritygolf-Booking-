import assert from "node:assert/strict";
import test from "node:test";

import { getClientsState, isUnauthorizedClientsError, loadClients, replaceClients, resetClients } from "./clientsStore";

function answer(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("one in-flight read is shared, and the answer is cleaned", async () => {
  resetClients();
  let calls = 0;
  const reply = answer(200, { people: [{ id: "p1", name: "Ada", external: "yes" }] });
  globalThis.fetch = (async () => {
    calls += 1;
    return reply();
  }) as typeof fetch;

  const [first, second] = await Promise.all([loadClients(), loadClients()]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(getClientsState().status, "loaded");
  assert.equal(first[0]?.name, "Ada");
  // "yes" is not true: the flag only survives as a real boolean.
  assert.equal(first[0]?.external, false);
});

test("a recent list is reused when the caller allows it, and refetched when it does not", async () => {
  resetClients();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return answer(200, { people: [] })();
  }) as typeof fetch;

  await loadClients();
  await loadClients({ maxAgeMs: 60_000 });
  assert.equal(calls, 1);
  await loadClients();
  assert.equal(calls, 2);
});

test("a 401 reads as unauthorized and caches nothing", async () => {
  resetClients();
  globalThis.fetch = answer(401, { message: "no" }) as unknown as typeof fetch;
  await assert.rejects(loadClients(), (error) => isUnauthorizedClientsError(error));
  assert.equal(getClientsState().status, "error");
  assert.equal(getClientsState().loadedAt, 0);
});

test("a failed revalidation keeps the list that was already on screen", async () => {
  resetClients();
  replaceClients([{ id: "p1", name: "Ada", email: "", phone: "", notes: "", source: "", caddyProfileId: "", caddyProfileUrl: "" }]);
  globalThis.fetch = answer(500, { message: "down" }) as unknown as typeof fetch;
  await assert.rejects(loadClients());
  assert.equal(getClientsState().status, "loaded");
  assert.equal(getClientsState().people.length, 1);
  assert.equal(getClientsState().error, "down");
});
