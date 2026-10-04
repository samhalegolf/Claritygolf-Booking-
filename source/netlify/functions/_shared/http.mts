import { safeJsonStringify } from "./values.mts";

/**
 * A JSON response, uncached. Every function answers with this one.
 *
 * Serialised with safeJsonStringify, so a bigint from Postgres or a cycle
 * cannot turn a good answer into a 500.
 */
export function json(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string | string[] | null | undefined> = {},
) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  // An array value is appended one header at a time. Set-Cookie is the reason:
  // logout clears both the admin and the player cookie, and a comma-joined
  // Set-Cookie is not a valid header -- the browser would drop both.
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined && value !== null) {
      headers.set(name, value);
    }
  }
  return new Response(safeJsonStringify(value), { status, headers });
}
