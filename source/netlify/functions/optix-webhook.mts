import { timingSafeEqual } from "node:crypto";
import type { Config } from "@netlify/functions";

import { storeOptixWebhookEvent, webhookEventKey } from "./_shared/optix-origin.mts";

function env(name: string) {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sameSecret(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function suppliedSecret(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return req.headers.get("x-optix-webhook-secret") || bearer;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const expectedSecret = env("OPTIX_WEBHOOK_SECRET");
  if (!expectedSecret) return json({ error: "webhook_not_configured" }, 503);
  if (!sameSecret(suppliedSecret(req), expectedSecret)) return json({ error: "unauthorized" }, 401);

  const rawBody = await req.text();
  if (!rawBody) return json({ error: "empty_body" }, 400);

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Event names and payload shape remain deliberately unassumed until verified
  // against a real Optix delivery. Store first; processing is a separate step.
  const eventType = String(req.headers.get("x-optix-event") || payload?.event_type || payload?.type || "").trim();
  const externalBookingId = String(payload?.booking_id || payload?.booking?.id || payload?.data?.booking_id || "").trim();
  const suppliedEventKey = String(req.headers.get("x-optix-event-id") || payload?.event_id || payload?.id || "").trim();
  const eventKey = webhookEventKey(rawBody, suppliedEventKey);

  try {
    const stored = await storeOptixWebhookEvent({ eventKey, eventType, externalBookingId, payload });
    return json({ ok: true, accepted: true, duplicate: !stored.inserted, eventKey }, 202);
  } catch (error: any) {
    return json({
      ok: false,
      error: String(error?.code || "webhook_store_failed"),
      message: error instanceof Error ? error.message : "Unable to store Optix webhook event.",
    }, 500);
  }
}

export const config: Config = { path: "/api/optix-webhook" };
