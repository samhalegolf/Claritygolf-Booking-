import type { Config } from "@netlify/functions";

import { handleCalendarFeedRequest } from "./booking-core.mts";

function requestFromEvent(event: any) {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";
  const host = event.headers?.host || event.headers?.Host || "claritygolf.app";
  const rawUrl =
    event.rawUrl ||
    `https://${host}${event.rawPath || event.path || "/calendar/feed.ics"}${event.rawQuery ? `?${event.rawQuery}` : ""}`;
  return new Request(rawUrl, { method, headers: event.headers || {} });
}

async function lambdaResponse(response: Response) {
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
}

export async function handler(event: any) {
  const req = requestFromEvent(event);
  const debug = new URL(req.url).searchParams.get("debug");
  if (debug === "ping") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      body: "calendar-feed-ok",
    };
  }
  return lambdaResponse(await handleCalendarFeedRequest(req));
}

export const config: Config = {
  path: "/calendar/*",
};
