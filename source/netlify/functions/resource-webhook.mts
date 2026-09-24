import type { Config } from "@netlify/functions";

import { readStoredCredentials, resolveWebhookAccount } from "./_shared/integration-credentials.mts";
import {
  EVENT_HEADER,
  RESOURCE_WEBHOOK_INBOUND_EVENTS,
  SIGNATURE_HEADER,
  verifyResourceWebhookSignature,
} from "./_shared/resource-webhook.mts";
import {
  applyInboundResourceEvent,
  RESOURCE_WEBHOOK_INTEGRATION_ID,
  RESOURCE_WEBHOOK_SECRET_FIELD,
} from "./_shared/resource-webhook-provider.mts";

/**
 * Changes a business's bay system makes on its own side.
 *
 * POST /api/resource-webhook?account=<business>, signed with the same secret
 * Clarity signs its own requests with (x-clarity-signature). Two events:
 *
 *   resource.released  { "event": "resource.released", "booking": { "id": "<Clarity booking id>" } }
 *   resource.updated   { "event": "resource.updated", "booking": { "id": "..." },
 *                        "hold": { "reference": "B-124", "resource": { "id": "3", "name": "Bay 3" } } }
 *
 * The URL names the business; the signature is what proves the request is
 * theirs. An unsigned or wrongly signed request changes nothing.
 */

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const accountId = await resolveWebhookAccount(req);
  if (!accountId) return json({ error: "unknown_account" }, 404);
  const body = await req.text();
  const secrets = await readStoredCredentials(accountId, RESOURCE_WEBHOOK_INTEGRATION_ID);
  const secret = String(secrets[RESOURCE_WEBHOOK_SECRET_FIELD] || "");
  if (!verifyResourceWebhookSignature(secret, body, req.headers.get(SIGNATURE_HEADER))) {
    return json({ error: "bad_signature", message: "Signature missing, wrong, or older than five minutes." }, 401);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const event = String(req.headers.get(EVENT_HEADER) || parsed?.event || "");
  if (!(RESOURCE_WEBHOOK_INBOUND_EVENTS as readonly string[]).includes(event)) {
    return json({ error: "unknown_event", message: `Send one of: ${RESOURCE_WEBHOOK_INBOUND_EVENTS.join(", ")}.` }, 400);
  }
  const result = await applyInboundResourceEvent(accountId, event, parsed);
  console.info("resource_webhook_inbound", { accountId, event, ok: result.ok, status: result.status });
  return json({ ok: result.ok, message: result.message }, result.status);
}

export const config: Config = { path: "/api/resource-webhook" };
