import assert from "node:assert/strict";
import test from "node:test";

import { withPublicReadCache } from "./public-read-cache.mts";

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
