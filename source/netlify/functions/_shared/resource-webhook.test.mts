import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanResourceWebhookUrl,
  parseResourceWebhookReply,
  sampleResourceWebhookPayload,
  sendResourceWebhook,
  signResourceWebhook,
  verifyResourceWebhookSignature,
} from "./resource-webhook.mts";

test("a signature verifies with the same secret, and nothing else", () => {
  const body = JSON.stringify({ event: "resource.released" });
  const now = 1_790_000_000;
  const header = signResourceWebhook("whsec_a", body, now);
  assert.equal(verifyResourceWebhookSignature("whsec_a", body, header, now), true);
  assert.equal(verifyResourceWebhookSignature("whsec_b", body, header, now), false);
  assert.equal(verifyResourceWebhookSignature("whsec_a", body + " ", header, now), false);
  assert.equal(verifyResourceWebhookSignature("whsec_a", body, header, now + 10 * 60), false, "stale");
  assert.equal(verifyResourceWebhookSignature("whsec_a", body, "", now), false);
});

test("only public https URLs are accepted", () => {
  assert.equal(cleanResourceWebhookUrl("https://bays.example.com/hook"), "https://bays.example.com/hook");
  for (const bad of ["http://bays.example.com", "https://localhost/x", "https://10.0.0.4/x", "https://192.168.1.2", "https://172.20.0.1", "ftp://x", "not a url", ""]) {
    assert.equal(cleanResourceWebhookUrl(bad), "", bad);
  }
});

test("a hold needs held + reference; unavailable is a refusal", () => {
  const held = parseResourceWebhookReply("resource.hold", 200, JSON.stringify({ status: "held", reference: "B-1", resource: { id: "7", name: "Bay 7" } }));
  assert.deepEqual(held, { ok: true, status: "held", reference: "B-1", resource: { id: "7", name: "Bay 7" } });
  const none = parseResourceWebhookReply("resource.hold", 200, JSON.stringify({ status: "unavailable", message: "Full" }));
  assert.equal(none.ok, false);
  assert.equal(none.ok === false && none.status, "unavailable");
  assert.equal(parseResourceWebhookReply("resource.hold", 200, JSON.stringify({ status: "held" })).ok, false, "no reference");
  assert.equal(parseResourceWebhookReply("resource.hold", 200, "OK").ok, false, "not JSON");
  assert.equal(parseResourceWebhookReply("resource.hold", 500, "").ok, false);
});

test("a release or test needs only a 2xx", () => {
  assert.equal(parseResourceWebhookReply("resource.release", 204, "").ok, true);
  assert.equal(parseResourceWebhookReply("resource.test", 200, "anything").ok, true);
  assert.equal(parseResourceWebhookReply("resource.release", 404, "").ok, false);
});

test("the request is signed and carries the event; a timeout or network error is a reply, not a throw", async () => {
  let seen: { headers: Record<string, string>; body: string } | null = null;
  const fakeFetch = (async (_url: string, init: any) => {
    seen = { headers: init.headers, body: init.body };
    return new Response(JSON.stringify({ status: "held", reference: "B-9", resource: { id: "2" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const payload = sampleResourceWebhookPayload("resource.hold");
  const reply = await sendResourceWebhook({ url: "https://x.example", secret: "whsec_t", payload }, fakeFetch);
  assert.equal(reply.ok, true);
  assert.equal(seen!.headers["x-clarity-event"], "resource.hold");
  assert.equal(verifyResourceWebhookSignature("whsec_t", seen!.body, seen!.headers["x-clarity-signature"]), true);

  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const down = await sendResourceWebhook({ url: "https://x.example", secret: "s", payload }, failing);
  assert.equal(down.ok, false);
  assert.equal(down.ok === false && down.code, "network_error");
});

test("a lesson's times go out in the location's own offset, across daylight saving", async () => {
  const { slotWallClock } = await import("./resource-webhook-provider.mts");
  // Week 17, Monday = 28 Sep 2026: NZ daylight saving started the day before.
  assert.equal(slotWallClock(17, 0, 600, "Pacific/Auckland").iso, "2026-09-28T10:00:00+13:00");
  // Week 16, Monday = 21 Sep 2026: still standard time.
  assert.equal(slotWallClock(16, 0, 600, "Pacific/Auckland").iso, "2026-09-21T10:00:00+12:00");
  assert.equal(slotWallClock(16, 0, 600, "UTC").iso, "2026-09-21T10:00:00+00:00");
  const { unix } = slotWallClock(16, 0, 600, "Pacific/Auckland");
  assert.equal(new Date(unix * 1000).toISOString(), "2026-09-20T22:00:00.000Z");
});
