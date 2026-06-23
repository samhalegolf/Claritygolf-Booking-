import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

function requestFromEvent(event: any) {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";
  const host = event.headers?.host || event.headers?.Host || "claritygolf.app";
  const rawUrl =
    event.rawUrl ||
    `https://${host}${event.rawPath || event.path || "/api/auth/login"}${event.rawQuery ? `?${event.rawQuery}` : ""}`;
  const body = ["GET", "HEAD"].includes(method)
    ? undefined
    : event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : event.body || "";
  return new Request(rawUrl, { method, headers: event.headers || {}, body });
}

async function lambdaResponse(response: Response) {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

export async function handler(event: any, context: Context) {
  return lambdaResponse(await handleBookingApiRoute(requestFromEvent(event), "/api/auth/login", context));
}

export const config: Config = {
  path: "/api/auth/login",
};
