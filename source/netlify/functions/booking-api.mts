import type { Config, Context } from "@netlify/functions";

import { handleBookingApiRoute } from "./booking-core.mts";

const databaseAdapterBuild = "supabase-local-adapter-v7";

function requestFromEvent(event: any) {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";
  const host = event.headers?.host || event.headers?.Host || "claritygolf.app";
  const rawUrl =
    event.rawUrl ||
    `https://${host}${event.rawPath || event.path || "/api/"}${event.rawQuery ? `?${event.rawQuery}` : ""}`;
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
  void databaseAdapterBuild;
  return lambdaResponse(await handleBookingApiRoute(requestFromEvent(event), "", context));
}

export const config: Config = {
  path: "/api/*",
  excludedPath: [
    "/api/auth/login",
    "/api/auth/session",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/change-password",
    "/api/auth/logout",
    "/api/calendar-state",
    "/api/coaches",
    "/api/locations",
    "/api/admin-settings",
    "/api/notification-history",
    "/api/test-email",
    "/api/system-smoke",
    "/api/google-calendar/*",
    "/api/google-calendar-sync",
    "/api/public-booking-state",
    "/api/public-notification-status",
    "/api/public-booking",
    "/api/public-booking-notifications",
    "/api/public-calendar-invite",
    "/api/public-cancel",
    "/api/public-reschedule",
    "/api/public-reschedule-lookup",
    "/api/public-reschedule/lookup",
    "/api/people/migrate",
  ],
};
