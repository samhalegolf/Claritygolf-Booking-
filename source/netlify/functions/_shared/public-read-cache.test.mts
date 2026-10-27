import assert from "node:assert/strict";
import test from "node:test";

import { publicCacheTagHeader, purgePublicBookingCache, withPublicReadCache } from "./public-read-cache.mts";
import { setSettingsBulk } from "./settings-store.mts";

const seconds = { maxAge: 60, staleWhileRevalidate: 300 };
const ok = () => new Response("{}", { status: 200 });

test("a read that names its business is cached at the CDN", () => {
  const response = withPublicReadCache(new Request("https://book.example/api/public-booking-catalog?business=sam-hale-golf"), ok(), seconds);
  assert.equal(response.headers.get("Netlify-CDN-Cache-Control"), "public, durable, max-age=60, stale-while-revalidate=300");
});

test("a bare legacy link is never cached, so an old copy cannot outlive it", () => {
  const response = withPublicReadCache(new Request("https://book.example/api/public-booking-catalog"), ok(), seconds);
  assert.equal(response.headers.get("Netlify-CDN-Cache-Control"), null);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("an error is never cached", () => {
  const response = withPublicReadCache(
    new Request("https://book.example/api/public-booking-catalog?business=gone"),
    new Response("{}", { status: 404 }),
    seconds,
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Netlify-CDN-Cache-Control"), null);
});

test("a business's public reads share one cache tag", () => {
  assert.deepEqual(publicCacheTagHeader("sam-hale-golf"), { "Netlify-Cache-Tag": "public-booking-sam-hale-golf" });
});

test("a save that stamps updatedAt purges that business's cached reads, and only then", async () => {
  const realFetch = globalThis.fetch;
  const purged: unknown[] = [];
  process.env.NETLIFY_PURGE_API_TOKEN = "test-token";
  process.env.SITE_ID = "test-site";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    purged.push(JSON.parse(String(init.body)).cache_tags);
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  try {
    const run = async () => undefined;
    await setSettingsBulk("sam-hale-golf", { servicesJson: "[]", updatedAt: "2026-10-27T00:00:00Z" }, run);
    await setSettingsBulk("sam-hale-golf", { syncKey: "abc" }, run);
    assert.deepEqual(purged, [["public-booking-sam-hale-golf"]]);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NETLIFY_PURGE_API_TOKEN;
    delete process.env.SITE_ID;
  }
});

test("a purge the CDN refuses does not fail the save", async () => {
  const realFetch = globalThis.fetch;
  process.env.NETLIFY_PURGE_API_TOKEN = "test-token";
  process.env.SITE_ID = "test-site";
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  try {
    await purgePublicBookingCache("sam-hale-golf");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.NETLIFY_PURGE_API_TOKEN;
    delete process.env.SITE_ID;
  }
});

test("without a purge token (tests, local) nothing is purged", async () => {
  await purgePublicBookingCache("sam-hale-golf");
});
