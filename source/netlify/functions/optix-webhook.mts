import type { Config } from "@netlify/functions";

import { processStoredExternalEvent, storeOptixWebhookEvent, webhookEventKey } from "./_shared/integrations/ingest.mts";
import { integrationRequest } from "./_shared/integrations/db.mts";
import { notifyBookingEvent, sendCoachPushForBooking } from "./notification-engine.mts";
import { validateOptixWebhook } from "./_shared/integrations/providers/optix-webhook-auth.mts";
import { integrationCredentials, resolveWebhookAccount } from "./_shared/integration-credentials.mts";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Whose Optix app this delivery claims to come from. The URL names the
  // business; that business's own client id and secret then have to verify
  // the signature, so naming a business without its secret gets nowhere.
  const accountId = await resolveWebhookAccount(req);
  if (!accountId) return json({ ok: false, error: "unknown_business", message: "This webhook URL names no business." }, 404);
  const credentials = await integrationCredentials(accountId, "optix");

  const rawBody = await req.text();
  const validation = validateOptixWebhook({
    rawBody,
    contentType: req.headers.get("content-type") || "",
    expectedClientId: credentials("OPTIX_CLIENT_ID"),
    appSecret: credentials("OPTIX_APP_SECRET"),
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
    //
    // This ran receipt-only from 5 Aug to 13 Aug 2026 as a stopgap after Optix
    // events overwrote Clarity lessons. The guards that stopgap stood in for
    // now live in processStoredExternalEvent(): assertSafeExistingLink() refuses
    // any item Optix does not exclusively own, findDuplicateBooking() catches a
    // lesson the coach already has, and every inbound booking files under the
    // reserved External Booking lesson type so it can never reclassify a native
    // one. Leaving it receipt-only silently stranded 804 events instead.
    //
    // Gated on stored.inserted: a redelivery of an event already on file is a
    // duplicate, and replaying it would re-run the import.
    if (stored.inserted) {
      try {
        const processed: any = await processStoredExternalEvent("optix", eventKey, payload, { accountId });
        if (processed?.status === "processed" && processed?.created) {
          // The coach's pop-up is not tied to the client's email behaviour —
          // a booking landing on the calendar is worth knowing about whether
          // or not this mapping sends the customer a confirmation.
          await sendCoachPushForBooking({ action: "booking", appointment: processed.item, source: `optix:${eventKey}` });

          if (processed?.mapping?.emailBehaviour === "immediate") {
            await notifyBookingEvent({ action: "booking", appointment: processed.item, source: `optix:${eventKey}` });
            await integrationRequest(`external_booking_links?provider=eq.optix&purpose=eq.lesson&external_booking_id=eq.${encodeURIComponent(externalBookingId)}`, {
              method: "PATCH",
              body: JSON.stringify({ email_status: "sent", confirmation_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
            });
          }
        }
      } catch (error) {
        // The event is stored and marked failed by processStoredExternalEvent, so
        // it stays retryable from the integration panel.
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
