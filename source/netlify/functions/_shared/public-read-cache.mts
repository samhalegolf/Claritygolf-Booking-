/**
 * CDN caching for the public booking page's reads (catalogue, slots, state).
 *
 * Only a request that names its business is cached. A bare legacy link asks
 * for "the only live business", and that answer changes when a second one
 * is added: the request then fails, but the CDN kept serving the last good
 * copy, so the page showed old lesson types and nothing said why. Uncached,
 * a bare link that cannot be resolved shows its error straight away.
 */
const BUSINESS_PARAMS = ["business", "account", "accountId", "slug"];

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
