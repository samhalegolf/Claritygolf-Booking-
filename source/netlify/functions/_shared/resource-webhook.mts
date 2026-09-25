/**
 * The webhook contract between Clarity and another booking system that keeps
 * a business's bays or rooms.
 *
 * Clarity defines the format, not the other system: every venue's software is
 * different, so rather than learn each one, Clarity sends one documented
 * message and expects one documented reply. A venue whose software cannot
 * speak it directly puts a small adapter in between (their own code, or a
 * no-code tool). The Settings guide shows these exact shapes.
 *
 * Outbound, Clarity -> their system (POST, JSON, signed):
 *
 *   resource.hold     A lesson needs a bay. Hold one and say which.
 *   resource.move     The lesson moved. Move the hold, or say you cannot.
 *   resource.release  The lesson is cancelled. Let the hold go.
 *   resource.test     Sent from the setup guide. Reply 2xx.
 *
 * Their reply is read synchronously (the business chose this on 2026-09-25: a
 * bay counts as booked only once the system that owns it says so):
 *
 *   { "status": "held", "reference": "B-123", "resource": { "id": "7", "name": "Bay 7" } }
 *   { "status": "unavailable", "message": "No bay free" }
 *
 * For a release any 2xx is enough. Anything that is not 2xx, not JSON where
 * JSON is needed, or slower than the timeout, is a failure the coach sees.
 *
 * Inbound, their system -> Clarity (optional, same signature scheme), for
 * changes made on their side: resource.released, resource.updated.
 *
 * Pure apart from sendResourceWebhook, which does the one network call.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RESOURCE_WEBHOOK_EVENTS = ["resource.hold", "resource.move", "resource.release", "resource.test"] as const;
export type ResourceWebhookEvent = (typeof RESOURCE_WEBHOOK_EVENTS)[number];

export const RESOURCE_WEBHOOK_INBOUND_EVENTS = ["resource.released", "resource.updated"] as const;
export type ResourceWebhookInboundEvent = (typeof RESOURCE_WEBHOOK_INBOUND_EVENTS)[number];

/** How long Clarity waits for a reply. A booking page is waiting behind a hold. */
export const RESOURCE_WEBHOOK_TIMEOUT_MS = 10_000;

/** Signed requests older or newer than this are refused, so a captured one cannot be replayed later. */
export const RESOURCE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export const SIGNATURE_HEADER = "x-clarity-signature";
export const EVENT_HEADER = "x-clarity-event";
export const DELIVERY_HEADER = "x-clarity-delivery";

export type ResourceWebhookBooking = {
  id: string;
  status: string;
  /** ISO 8601 with the location's offset, e.g. 2026-09-28T10:00:00+13:00. */
  start: string;
  end: string;
  timezone: string;
  durationMinutes: number;
  service: { id: string; name: string };
  coach: { id: string; name: string };
  location: { id: string; name: string };
  client: { name: string; email: string; phone: string };
  handedness: "left" | "right" | null;
  notes: string;
};

export type ResourceWebhookPayload = {
  event: ResourceWebhookEvent;
  id: string;
  sentAt: string;
  account: { id: string; name: string };
  booking: ResourceWebhookBooking | null;
  /** What Clarity last heard from you about this booking. Null on a first hold. */
  hold: { reference: string; resource: { id: string; name: string } } | null;
  /** On a move, the times the hold is moving from. */
  previous: { start: string; end: string } | null;
};

export type ResourceWebhookReply =
  | { ok: true; status: "held"; reference: string; resource: { id: string; name: string } }
  | { ok: true; status: "released" }
  | { ok: false; status: "unavailable" | "error"; code: string; message: string };

export function generateSigningSecret() {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the same scheme Stripe uses. */
export function signResourceWebhook(secret: string, body: string, timestampSeconds: number) {
  const digest = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

export function verifyResourceWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    String(header)
      .split(",")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > RESOURCE_WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = signResourceWebhook(secret, body, timestamp).split("v1=")[1];
  const given = String(parts.v1 || "");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Only https, and never a private address: the URL is typed by a customer and called from our servers. */
export function cleanResourceWebhookUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("[")
  ) {
    return "";
  }
  return url.toString().slice(0, 500);
}

function text(value: unknown, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

/**
 * Read their reply. `event` decides what counts as success: a hold or move
 * needs `held` with a reference; a release or test needs only a 2xx.
 */
export function parseResourceWebhookReply(
  event: ResourceWebhookEvent,
  httpStatus: number,
  bodyText: string,
): ResourceWebhookReply {
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      status: "error",
      code: `http_${httpStatus}`,
      message: `Your system answered ${httpStatus}${bodyText ? `: ${text(bodyText, 200)}` : "."}`,
    };
  }
  if (event === "resource.release" || event === "resource.test") return { ok: true, status: "released" };
  let body: any;
  try {
    body = JSON.parse(bodyText || "");
  } catch {
    return { ok: false, status: "error", code: "invalid_reply", message: "Your system replied, but not with JSON." };
  }
  const status = text(body?.status, 40).toLowerCase();
  if (status === "unavailable") {
    return {
      ok: false,
      status: "unavailable",
      code: "resource_unavailable",
      message: text(body?.message, 300) || "Your system has no bay free at that time.",
    };
  }
  if (status !== "held") {
    return {
      ok: false,
      status: "error",
      code: "invalid_reply",
      message: `Expected "status": "held" or "unavailable", got ${status ? `"${status}"` : "nothing"}.`,
    };
  }
  const reference = text(body?.reference, 160);
  if (!reference) {
    return { ok: false, status: "error", code: "invalid_reply", message: 'A "held" reply needs a "reference".' };
  }
  const resourceId = text(body?.resource?.id, 120);
  return {
    ok: true,
    status: "held",
    reference,
    resource: { id: resourceId, name: text(body?.resource?.name, 120) || resourceId },
  };
}

/** One POST, signed, with a timeout. Never throws; a network failure is a reply. */
export async function sendResourceWebhook(
  input: { url: string; secret: string; payload: ResourceWebhookPayload },
  fetchImpl: typeof fetch = fetch,
): Promise<ResourceWebhookReply & { httpStatus: number; durationMs: number }> {
  const startedAt = Date.now();
  const body = JSON.stringify(input.payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOURCE_WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Clarity-Resource-Webhook/1",
        [EVENT_HEADER]: input.payload.event,
        [DELIVERY_HEADER]: input.payload.id,
        [SIGNATURE_HEADER]: signResourceWebhook(input.secret, body, Math.floor(Date.now() / 1000)),
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    const replyText = (await response.text().catch(() => "")).slice(0, 4000);
    return {
      ...parseResourceWebhookReply(input.payload.event, response.status, replyText),
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (error: any) {
    const timedOut = error?.name === "AbortError";
    return {
      ok: false,
      status: "error",
      code: timedOut ? "timeout" : "network_error",
      message: timedOut
        ? `Your system did not answer within ${RESOURCE_WEBHOOK_TIMEOUT_MS / 1000} seconds.`
        : `Could not reach your system: ${text(error?.message, 200) || "network error"}.`,
      httpStatus: 0,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The example the setup guide shows, so what it documents is what is sent. */
export function sampleResourceWebhookPayload(event: ResourceWebhookEvent = "resource.hold"): ResourceWebhookPayload {
  const booking: ResourceWebhookBooking = {
    id: "appt_8f2c1d",
    status: event === "resource.release" ? "cancelled" : "booked",
    start: "2026-09-28T10:00:00+13:00",
    end: "2026-09-28T11:00:00+13:00",
    timezone: "Pacific/Auckland",
    durationMinutes: 60,
    service: { id: "lesson-60", name: "60 min lesson" },
    coach: { id: "coach-sam", name: "Sam" },
    location: { id: "main-range", name: "Main Range" },
    client: { name: "Alex Player", email: "alex@example.com", phone: "+64 21 000 0000" },
    handedness: "right",
    notes: "",
  };
  return {
    event,
    id: "dlv_01J8Z6Y3QX",
    sentAt: "2026-09-25T08:00:00.000Z",
    account: { id: "your-business", name: "Your Business" },
    booking: event === "resource.test" ? null : booking,
    hold:
      event === "resource.hold" || event === "resource.test"
        ? null
        : { reference: "B-123", resource: { id: "7", name: "Bay 7" } },
    previous: event === "resource.move" ? { start: "2026-09-28T09:00:00+13:00", end: "2026-09-28T10:00:00+13:00" } : null,
  };
}
