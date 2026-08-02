import type { Config } from "@netlify/functions";

import { optixOriginRequest, processStoredOptixEvent, storeOptixWebhookEvent, webhookEventKey } from "./_shared/optix-origin.mts";
import { notifyBookingEvent } from "./notification-engine.mts";
import { validateOptixWebhook } from "./_shared/optix-webhook-auth.mts";

function env(name: string) {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || "").trim();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();
  const validation = validateOptixWebhook({
    rawBody,
    contentType: req.headers.get("content-type") || "",
    expectedClientId: env("OPTIX_CLIENT_ID"),
    appSecret: env("OPTIX_APP_SECRET"),
  });

  if (validation.ok === false) {
    const status = validation.error === "webhook_not_configured"
      ? 503
      : validation.error === "unsupported_media_type"
        ? 415
        : validation.error === "invalid_signature" || validation.error === "client_id_mismatch"
          ? 401
          : 400;
    return json({ ok: false, error: validation.error, message: validation.message }, status);
  }

  const payload = validation.payload;
  const eventType = String(payload.event || "").trim();
  const externalBookingId = String(payload.booking_id || "").trim();
  const eventKey = webhookEventKey(rawBody);

  try {
    const stored = await storeOptixWebhookEvent({
      eventKey,
      eventType,
      externalBookingId,
      payload,
    });
    // Receipt is already durable at this point. Processing is deliberately
    // isolated so a Clarity failure cannot turn a valid Optix delivery into a
    // retry-triggering non-2xx response.
    if (stored.inserted) {
      try {
        const processed: any = await processStoredOptixEvent(eventKey, payload);
        if (processed?.status === "processed" && processed?.mapping?.emailBehaviour === "immediate" && processed?.created) {
          await notifyBookingEvent({ action: "booking", appointment: processed.item, source: `optix:${eventKey}` });
          await optixOriginRequest(`external_booking_links?provider=eq.optix&purpose=eq.lesson&external_booking_id=eq.${encodeURIComponent(externalBookingId)}`, {
            method: "PATCH",
            body: JSON.stringify({ email_status: "sent", confirmation_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
          });
        }
      } catch (error) {
        console.error("optix_webhook_processing_failed", {
          eventKey,
          code: String((error as any)?.code || "processing_failed"),
        });
      }
    }
    return json({ ok: true, accepted: true, duplicate: !stored.inserted, eventKey }, 200);
  } catch (error: any) {
    return json({
      ok: false,
      error: String(error?.code || "webhook_store_failed"),
      message: error instanceof Error ? error.message : "Unable to store Optix webhook event.",
    }, 500);
  }
}

export const config: Config = { path: "/api/optix-webhook" };
