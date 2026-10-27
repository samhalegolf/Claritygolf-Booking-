/**
 * CDN caching for the public booking page's reads (catalogue, slots, state).
 *
 * Only a request that names its business is cached. A bare legacy link asks
 * for "the only live business", and that answer changes when a second one
 * is added: the request then fails, but the CDN kept serving the last good
 * copy, so the page showed old lesson types and nothing said why. Uncached,
 * a bare link that cannot be resolved shows its error straight away.
 */
import { purgeCache } from "@netlify/functions";

const BUSINESS_PARAMS = ["business", "account", "accountId", "slug"];

/**
 * The CDN tag on every cached public read of one business. A save purges it
 * (purgePublicBookingCache below), so a change to lessons, availability or a
 * booking reaches the booking page on its next load instead of when the cached
 * copy runs out.
 */
export function publicCacheTagHeader(accountId: string) {
  return { "Netlify-Cache-Tag": `public-booking-${accountId}` };
}

/**
 * Drop one business's cached public reads. A failed purge is logged and left:
 * the copies still expire on their own within a minute or so, and a save must
 * not fail because the CDN did not answer. Outside Netlify there is no token
 * and nothing to purge.
 */
export async function purgePublicBookingCache(accountId: string) {
  if (!accountId || !process.env.NETLIFY_PURGE_API_TOKEN) return;
  try {
    await purgeCache({ tags: [publicCacheTagHeader(accountId)["Netlify-Cache-Tag"]] });
  } catch (error) {
    console.error("public_booking_cache_purge_failed", accountId, error);
  }
}

export function withPublicReadCache(req: Request, response: Response, seconds: { maxAge: number; staleWhileRevalidate: number }) {
  const params = new URL(req.url).searchParams;
  const namesBusiness = BUSINESS_PARAMS.some((key) => params.get(key)?.trim());
  const headers = new Headers(response.headers);
  if (response.ok && namesBusiness) {
    headers.set(
      "Netlify-CDN-Cache-Control",
      `public, durable, max-age=${seconds.maxAge}, stale-while-revalidate=${seconds.staleWhileRevalidate}`,
    );
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  } else {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
