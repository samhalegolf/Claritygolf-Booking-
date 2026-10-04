/**
 * The conventions every /api/v1 response follows.
 *
 * Borrowed from the APIs developers already find easiest to integrate with
 * (Stripe above all), so nobody has to learn anything Clarity-specific to read
 * a reply:
 *
 *   - JSON in, JSON out, snake_case keys, ISO 8601 times with an offset.
 *   - Every object carries `object: "booking"` etc. so a payload names itself.
 *   - Lists are `{ object: "list", data, has_more, next_cursor }`; pass
 *     `?cursor=` to get the next page and `?limit=` (1-100) to size it.
 *   - Errors are `{ error: { type, code, message, param?, request_id } }` with
 *     a matching HTTP status.
 *   - Every reply has `Request-Id`; quote it when something goes wrong.
 *   - POSTs accept `Idempotency-Key`, so a retried request never books twice.
 *   - Rate limits are per key and reported in `RateLimit-*` headers.
 */
import { createHash, randomUUID } from "node:crypto";
import { getDatabase } from "../database.mts";

export const API_VERSION = "v1";

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "conflict_error"
  | "rate_limit_error"
  | "idempotency_error"
  | "api_error";

const STATUS_FOR: Record<ErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  idempotency_error: 409,
  rate_limit_error: 429,
  api_error: 500,
};

/** Thrown anywhere under a route; the router turns it into the error body. */
export class ApiError extends Error {
  type: ErrorType;
  code: string;
  param?: string;
  status: number;
  constructor(type: ErrorType, code: string, message: string, options: { param?: string; status?: number } = {}) {
    super(message);
    this.type = type;
    this.code = code;
    this.param = options.param;
    this.status = options.status || STATUS_FOR[type];
  }
}

export const invalid = (code: string, message: string, param?: string) =>
  new ApiError("invalid_request_error", code, message, { param });
export const notFound = (what: string, id: string) =>
  new ApiError("not_found_error", "resource_missing", `No ${what} with id '${id}'.`, { param: "id" });

export function newRequestId() {
  return `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export type ApiContext = {
  requestId: string;
  headers: Record<string, string>;
};

export function jsonResponse(ctx: ApiContext, value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "request-id": ctx.requestId,
      ...CORS_HEADERS,
      ...ctx.headers,
      ...extraHeaders,
    },
  });
}

export function errorResponse(ctx: ApiContext, error: ApiError) {
  return jsonResponse(
    ctx,
    {
      error: {
        type: error.type,
        code: error.code,
        message: error.message,
        ...(error.param ? { param: error.param } : {}),
        request_id: ctx.requestId,
      },
    },
    error.status,
  );
}

/**
 * Browsers may call the API directly (a club's own website, a no-code tool).
 * Authentication is a bearer key, never a cookie, so allowing any origin
 * exposes nothing a key holder could not already do from a server.
 */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, idempotency-key",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": "request-id, ratelimit-limit, ratelimit-remaining, ratelimit-reset, retry-after",
  "access-control-max-age": "86400",
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid("invalid_json", "The request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("invalid_json", "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function str(value: unknown, max = 500): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function requireStr(body: Record<string, unknown>, key: string, max = 500): string {
  const value = str(body[key], max);
  if (!value) throw invalid("parameter_missing", `'${key}' is required.`, key);
  return value;
}

/** An ISO 8601 instant, or throws naming the parameter. Empty in, "" out. */
export function isoParam(value: unknown, param: string): string {
  const raw = str(value, 60);
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw invalid("parameter_invalid", `'${param}' must be an ISO 8601 date-time.`, param);
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Pagination: opaque cursors over a stable sort key
// ---------------------------------------------------------------------------

export function pageLimit(url: URL, fallback = 25) {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw invalid("parameter_invalid", "'limit' must be a whole number from 1 to 100.", "limit");
  }
  return value;
}

export function encodeCursor(value: unknown[]) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(url: URL): unknown[] | null {
  const raw = url.searchParams.get("cursor");
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw invalid("parameter_invalid", "'cursor' is not one this API issued.", "cursor");
}

/** Takes limit+1 rows, returns the page and whether there is more. */
export function listPage<T>(rows: T[], limit: number, cursorOf: (last: T) => unknown[], map: (row: T) => unknown) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    object: "list",
    data: page.map(map),
    has_more: hasMore,
    next_cursor: hasMore && page.length ? encodeCursor(cursorOf(page[page.length - 1])) : null,
  };
}

// ---------------------------------------------------------------------------
// Rate limiting: fixed one-minute windows, per key, in Postgres
// ---------------------------------------------------------------------------

export const RATE_LIMIT_PER_MINUTE = 300;

export async function checkRateLimit(keyId: string, limit = RATE_LIMIT_PER_MINUTE) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / 60_000) * 60_000);
  const rows = await getDatabase().sql`
    INSERT INTO api_rate_limits (key_id, window_start, request_count)
    VALUES (${keyId}, ${windowStart.toISOString()}, 1)
    ON CONFLICT (key_id, window_start)
    DO UPDATE SET request_count = api_rate_limits.request_count + 1
    RETURNING request_count
  `;
  const count = Number(rows[0]?.request_count || 1);
  const resetSeconds = Math.max(1, Math.ceil((windowStart.getTime() + 60_000 - now) / 1000));
  return {
    allowed: count <= limit,
    headers: {
      "ratelimit-limit": String(limit),
      "ratelimit-remaining": String(Math.max(0, limit - count)),
      "ratelimit-reset": String(resetSeconds),
    },
    retryAfter: resetSeconds,
  };
}

// ---------------------------------------------------------------------------
// Idempotency: the same key + same body replays the first answer
// ---------------------------------------------------------------------------

export function requestHash(method: string, path: string, body: string) {
  return createHash("sha256").update(`${method} ${path}\n${body}`).digest("hex");
}

/**
 * Claims an idempotency key, or returns the stored reply for one already used.
 *
 * `in_progress` means a request with this key is still running -- two retries
 * racing each other -- and the second is told to try again rather than run
 * twice.
 */
export async function claimIdempotencyKey(keyId: string, idempotencyKey: string, hash: string) {
  const inserted = await getDatabase().sql`
    INSERT INTO api_idempotency_keys (key_id, idempotency_key, request_hash)
    VALUES (${keyId}, ${idempotencyKey}, ${hash})
    ON CONFLICT (key_id, idempotency_key) DO NOTHING
    RETURNING key_id
  `;
  if (inserted.length) return { state: "claimed" as const };
  const rows = await getDatabase().sql`
    SELECT request_hash, status_code, response_body, created_at
    FROM api_idempotency_keys
    WHERE key_id = ${keyId} AND idempotency_key = ${idempotencyKey}
  `;
  const row = rows[0];
  if (!row) return { state: "claimed" as const };
  if (row.request_hash !== hash) return { state: "mismatch" as const };
  if (row.status_code === null || row.status_code === undefined) return { state: "in_progress" as const };
  return { state: "replay" as const, status: Number(row.status_code), body: String(row.response_body || "") };
}

export async function storeIdempotentResponse(keyId: string, idempotencyKey: string, status: number, body: string) {
  // A server error is not a final answer: let the retry actually retry.
  if (status >= 500) {
    await getDatabase().sql`
      DELETE FROM api_idempotency_keys WHERE key_id = ${keyId} AND idempotency_key = ${idempotencyKey}
    `;
    return;
  }
  await getDatabase().sql`
    UPDATE api_idempotency_keys
    SET status_code = ${status}, response_body = ${body}
    WHERE key_id = ${keyId} AND idempotency_key = ${idempotencyKey}
  `;
}

/** Old idempotency keys and rate windows. Run from the webhook worker's schedule. */
export async function pruneApiWorkingTables() {
  await getDatabase().sql`DELETE FROM api_idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours'`;
  await getDatabase().sql`DELETE FROM api_rate_limits WHERE window_start < NOW() - INTERVAL '10 minutes'`;
}
