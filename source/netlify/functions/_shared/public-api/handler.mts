/**
 * The /api/v1 front door. In order, for every request:
 *
 *   1. CORS preflight answered; OpenAPI spec served without a key.
 *   2. Bearer key -> the one business it belongs to (401 otherwise).
 *   3. Rate limit for that key (429 with Retry-After).
 *   4. Route + scope (404 / 405 / 403).
 *   5. Idempotency-Key on POST: a replay returns the first answer.
 *   6. The route, with any error turned into the standard error body.
 */
import {
  ApiError,
  checkRateLimit,
  claimIdempotencyKey,
  errorResponse,
  jsonResponse,
  newRequestId,
  readJsonBody,
  requestHash,
  storeIdempotentResponse,
  CORS_HEADERS,
  type ApiContext,
} from "./http.mts";
import { authenticateApiKey, type ApiPrincipal } from "./keys.mts";
import { domainError, matchRoute } from "./routes.mts";
import { loadCatalog, type Catalog } from "./serialize.mts";
import { openApiSpec } from "./openapi.mts";

export const API_PREFIX = "/api/v1";

function bearerToken(req: Request) {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

export async function handleApiRequest(req: Request, netlifyContext: unknown = null): Promise<Response> {
  const ctx: ApiContext = { requestId: newRequestId(), headers: {} };
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/v1/, "") || "/";
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
  if (method === "GET" && (path === "/openapi.json" || path === "/")) {
    return jsonResponse(ctx, openApiSpec(url.origin), 200, { "cache-control": "public, max-age=300" });
  }

  let principal: ApiPrincipal | null = null;
  let idempotency: { key: string } | null = null;
  try {
    const token = bearerToken(req);
    if (!token) {
      throw new ApiError(
        "authentication_error",
        "missing_api_key",
        "No API key. Send it as 'Authorization: Bearer ck_live_…'. Keys are made in Clarity under Settings › API & webhooks.",
      );
    }
    principal = await authenticateApiKey(token);
    if (!principal) {
      throw new ApiError("authentication_error", "invalid_api_key", "That API key is not valid. It may have been revoked or mistyped.");
    }

    const limit = await checkRateLimit(principal.keyId);
    ctx.headers = { ...ctx.headers, ...limit.headers };
    if (!limit.allowed) {
      ctx.headers["retry-after"] = String(limit.retryAfter);
      throw new ApiError("rate_limit_error", "rate_limited", "Too many requests for this key. Slow down and retry after the time in Retry-After.");
    }

    const matched = matchRoute(method, path);
    if (!matched) throw new ApiError("not_found_error", "route_not_found", `No such route: ${method} ${url.pathname}.`);
    if ("methodNotAllowed" in matched) {
      throw new ApiError("invalid_request_error", "method_not_allowed", `${method} is not supported on ${url.pathname}.`, { status: 405 });
    }
    const { route, params } = matched;
    if (route.scope && !principal.scopes.has(route.scope)) {
      throw new ApiError(
        "permission_error",
        "insufficient_scope",
        `This key does not have the '${route.scope}' permission. Give it that permission in Settings › API & webhooks, or use another key.`,
      );
    }

    const rawBody = method === "GET" || method === "DELETE" ? "" : await req.clone().text();
    const idempotencyKey = (req.headers.get("idempotency-key") || "").trim().slice(0, 255);
    if (method === "POST" && idempotencyKey) {
      const claim = await claimIdempotencyKey(principal.keyId, idempotencyKey, requestHash(method, url.pathname, rawBody));
      if (claim.state === "replay") {
        return new Response(claim.body, {
          status: claim.status,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "request-id": ctx.requestId,
            "idempotent-replayed": "true",
            ...CORS_HEADERS,
            ...ctx.headers,
          },
        });
      }
      if (claim.state === "mismatch") {
        throw new ApiError("idempotency_error", "idempotency_key_reused", "This Idempotency-Key was already used with a different request.");
      }
      if (claim.state === "in_progress") {
        throw new ApiError("idempotency_error", "idempotency_in_progress", "A request with this Idempotency-Key is still running. Retry shortly.");
      }
      idempotency = { key: idempotencyKey };
    }

    const body = method === "GET" || method === "DELETE" ? {} : await readJsonBody(req);
    let catalogPromise: Promise<Catalog> | null = null;
    const accountPrincipal = principal;
    const result = await route.handler({
      principal: accountPrincipal,
      url,
      params,
      body,
      netlifyContext,
      catalog: () => (catalogPromise ||= loadCatalog(accountPrincipal.accountId, accountPrincipal.mode === "live")),
    });
    const status = result.status || 200;
    const response = jsonResponse(ctx, result.body, status);
    if (idempotency) await storeIdempotentResponse(principal.keyId, idempotency.key, status, JSON.stringify(result.body));
    return response;
  } catch (error) {
    const apiError = domainError(error);
    if (apiError.status >= 500) {
      console.error("public_api:error", { requestId: ctx.requestId, path, method, error });
    }
    if (idempotency && principal) {
      await storeIdempotentResponse(principal.keyId, idempotency.key, apiError.status, JSON.stringify({
        error: { type: apiError.type, code: apiError.code, message: apiError.message, ...(apiError.param ? { param: apiError.param } : {}), request_id: ctx.requestId },
      })).catch(() => undefined);
    }
    return errorResponse(ctx, apiError);
  }
}
