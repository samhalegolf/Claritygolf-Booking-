import type { Config } from "@netlify/functions";

import { requireCoachActor } from "./_shared/coach-auth.mts";
import { readSandboxAccount } from "./_shared/sandbox.mts";
import { API_SCOPES, SCOPE_LABELS, cleanScopes, createApiKey, listApiKeys, revokeApiKey } from "./_shared/public-api/keys.mts";
import {
  EVENT_TYPES,
  EndpointInputError,
  createEndpoint,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  retryDelivery,
  revealEndpointSecret,
  rollEndpointSecret,
  sendTestEvent,
  updateEndpoint,
} from "./_shared/public-api/events.mts";

/**
 * Settings › API & webhooks: where a business owner makes API keys and
 * webhook subscriptions. The coach's own login, never an API key -- a key
 * cannot make more keys.
 *
 *   GET                       keys, endpoints, and the vocabularies to draw them
 *   GET  ?deliveries=<id>     one endpoint's recent deliveries
 *   POST { action, ... }      create_key, revoke_key, create_endpoint,
 *                             update_endpoint, delete_endpoint, roll_secret,
 *                             reveal_secret, test_endpoint, retry_delivery
 *
 * Owners and admins only: a key can read every client in the business.
 */

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export default async function handler(req: Request) {
  try {
    const actor = await requireCoachActor(req);
    if (!actor.isAdmin) {
      return json({ error: "forbidden", message: "Only the business owner or an admin can manage API access." }, 403);
    }
    const accountId = actor.accountId;
    const mode = (await readSandboxAccount(accountId)) ? "test" : "live";
    const url = new URL(req.url);

    if (req.method === "GET") {
      const deliveriesFor = text(url.searchParams.get("deliveries"), 160);
      if (deliveriesFor) return json({ deliveries: await listDeliveries(accountId, deliveriesFor) });
      return json({
        mode,
        keys: await listApiKeys(accountId),
        endpoints: await listEndpoints(accountId),
        scopes: API_SCOPES.map((scope) => ({ id: scope, label: SCOPE_LABELS[scope] })),
        eventTypes: EVENT_TYPES,
        baseUrl: `${url.origin}/api/v1`,
        specUrl: `${url.origin}/api/v1/openapi.json`,
      });
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = text(body.id, 160);
    const missing = () => json({ error: "not_found", message: "That no longer exists. Refresh and try again." }, 404);

    switch (text(body.action, 40)) {
      case "create_key": {
        const name = text(body.name, 80);
        if (!name) return json({ error: "invalid", message: "Give the key a name, so you know later what uses it." }, 400);
        const scopes = cleanScopes(body.scopes);
        if (!scopes.length) return json({ error: "invalid", message: "Tick at least one permission." }, 400);
        const days = Number(body.expiresInDays);
        const expiresAt = Number.isInteger(days) && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
        const created = await createApiKey({ accountId, mode, name, scopes, createdBy: actor.authUserId, expiresAt });
        return json({ key: created.key, record: created.record }, 201);
      }
      case "revoke_key":
        return (await revokeApiKey(accountId, id)) ? json({ ok: true }) : missing();
      case "create_endpoint": {
        const created = await createEndpoint({
          accountId,
          url: body.url,
          events: body.events,
          description: body.description,
          createdBy: actor.authUserId,
        });
        return json(created, 201);
      }
      case "update_endpoint": {
        const endpoint = await updateEndpoint(accountId, id, {
          url: body.url,
          events: body.events,
          description: body.description,
          enabled: body.enabled,
        });
        return endpoint ? json({ endpoint }) : missing();
      }
      case "delete_endpoint":
        return (await deleteEndpoint(accountId, id)) ? json({ ok: true }) : missing();
      case "roll_secret": {
        const secret = await rollEndpointSecret(accountId, id);
        return secret ? json({ secret }) : missing();
      }
      case "reveal_secret": {
        const secret = await revealEndpointSecret(accountId, id);
        return secret ? json({ secret }) : missing();
      }
      case "test_endpoint": {
        const result = await sendTestEvent(accountId, id);
        return result ? json({ result }) : missing();
      }
      case "retry_delivery":
        return (await retryDelivery(accountId, id)) ? json({ ok: true }) : missing();
      default:
        return json({ error: "invalid", message: "Unknown action." }, 400);
    }
  } catch (error: any) {
    if (error instanceof EndpointInputError) return json({ error: "invalid", message: error.message, param: error.param }, 400);
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("api_access:failed", error);
    return json(
      { error: error?.code || "api_access_error", message: status >= 500 ? "Something went wrong. Try again." : error?.message },
      status,
    );
  }
}

export const config: Config = { path: "/api/api-access" };
