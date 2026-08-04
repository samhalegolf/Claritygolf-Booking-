import { createHash, timingSafeEqual } from "node:crypto";

export type OptixWebhookPayload = Record<string, string>;

export type OptixWebhookValidation =
  | { ok: true; payload: OptixWebhookPayload }
  | { ok: false; error: string; message: string };

function sameHex(actual: string, expected: string) {
  const normalizedActual = actual.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedActual)) return false;
  const actualBuffer = Buffer.from(normalizedActual, "hex");
  const expectedBuffer = Buffer.from(normalizedExpected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function optixWebhookSignature(clientId: string, appSecret: string, createdTimestamp: string) {
  return createHash("sha1")
    .update(`${clientId}${appSecret}${createdTimestamp}`, "utf8")
    .digest("hex");
}

export function parseOptixWebhookForm(rawBody: string): OptixWebhookPayload {
  const params = new URLSearchParams(rawBody);
  const payload: OptixWebhookPayload = {};
  for (const [key, value] of params.entries()) payload[key] = value;
  return payload;
}

export function validateOptixWebhook(input: {
  rawBody: string;
  contentType: string;
  expectedClientId: string;
  appSecret: string;
}): OptixWebhookValidation {
  if (!input.expectedClientId || !input.appSecret) {
    return { ok: false, error: "webhook_not_configured", message: "Optix webhook credentials are not configured." };
  }

  if (!input.contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return { ok: false, error: "unsupported_media_type", message: "Optix webhooks must use form encoding." };
  }

  if (!input.rawBody) {
    return { ok: false, error: "empty_body", message: "Webhook body is empty." };
  }

  const payload = parseOptixWebhookForm(input.rawBody);
  const clientId = String(payload.client_id || "").trim();
  const createdTimestamp = String(payload.created_timestamp || "").trim();
  const suppliedSignature = String(payload.request_signature || "").trim();
  const event = String(payload.event || "").trim();

  if (!clientId || !createdTimestamp || !suppliedSignature || !event) {
    return { ok: false, error: "invalid_payload", message: "Required Optix webhook fields are missing." };
  }

  if (clientId !== input.expectedClientId) {
    return { ok: false, error: "client_id_mismatch", message: "Webhook client ID does not match the configured Optix app." };
  }

  if (!/^\d+$/.test(createdTimestamp)) {
    return { ok: false, error: "invalid_timestamp", message: "Optix webhook timestamp is invalid." };
  }

  const expectedSignature = optixWebhookSignature(clientId, input.appSecret, createdTimestamp);
  if (!sameHex(suppliedSignature, expectedSignature)) {
    return { ok: false, error: "invalid_signature", message: "Optix webhook signature is invalid." };
  }

  return { ok: true, payload };
}
