import type { Config } from "@netlify/functions";

import {
  clearGoogleCalendarDebugLog,
  createGoogleCalendarAuthUrl,
  disconnectGoogleCalendar,
  finishGoogleCalendarOAuth,
  getGoogleCalendarDebugLog,
  getGoogleCalendarSyncStatus,
  googleCalendarDebugErrorFromUnknown,
  resolveGoogleCalendarCoach,
  setGoogleCalendarDebugEnabled,
  syncGoogleCalendarNow,
  updateGoogleCalendarSyncSettings,
} from "./google-calendar-sync.mts";


function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(value: string, status = 200) {
  return new Response(value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

function callbackPage(ok: boolean, message: string) {
  const escaped = message.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Calendar ${ok ? "Connected" : "Connection Failed"}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, system-ui, sans-serif; background: #f5f5f3; color: #171717; }
      main { width: min(440px, calc(100vw - 32px)); padding: 24px; border: 1px solid #deded8; border-radius: 12px; background: #fff; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { margin: 0 0 18px; color: #5d5a54; line-height: 1.45; }
      a { display: inline-flex; min-height: 42px; align-items: center; padding: 0 16px; border-radius: 8px; background: #111; color: #fff; text-decoration: none; font-weight: 800; }
    </style>
  </head>
  <body>
    <main>
      <h1>${ok ? "Google Calendar connected" : "Google Calendar not connected"}</h1>
      <p>${escaped}</p>
      <a href="/login?view=profile">Back to Clarity Booking</a>
    </main>
  </body>
</html>`;
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const action =
    url.pathname
      .replace(/^\/api\/google-calendar\/?/, "")
      .replace(/^\/\.netlify\/functions\/google-calendar\/?/, "") || "status";

  try {
    if (req.method === "GET" && action === "callback") {
      const status = await finishGoogleCalendarOAuth(req);
      return html(callbackPage(true, `Connected${status.accountEmail ? ` as ${status.accountEmail}` : ""}. You can close this tab.`));
    }

    // Google Calendar is connected per coach, so every route below needs the
    // coach (?coachId=, defaulting to the caller's own) and a caller allowed
    // to act for them -- themselves, or the owner or an admin.
    const { accountId, coachId } = await resolveGoogleCalendarCoach(req, url.searchParams.get("coachId") || "");

    if (req.method === "GET" && action === "status") return json(await getGoogleCalendarSyncStatus(accountId, coachId, req));
    if (req.method === "POST" && action === "connect") return json(await createGoogleCalendarAuthUrl(accountId, coachId, req));
    if (req.method === "POST" && action === "sync") return json(await syncGoogleCalendarNow(accountId, coachId, "manual_sync_now"));
    if (req.method === "POST" && action === "disconnect") return json(await disconnectGoogleCalendar(accountId, coachId, req));
    if ((req.method === "PUT" || req.method === "POST") && action === "settings") {
      return json(await updateGoogleCalendarSyncSettings(accountId, coachId, await parseBody(req)));
    }

    // Sync diagnostics: every trigger, the Google failure code, and the event
    // body that was sent. Read by the coach profile's debug window.
    if (req.method === "GET" && action === "debug") return json(await getGoogleCalendarDebugLog(accountId, coachId));
    if (req.method === "POST" && action === "debug/clear") return json(await clearGoogleCalendarDebugLog(accountId, coachId));
    if (req.method === "POST" && action === "debug/toggle") {
      const body = await parseBody(req);
      return json(await setGoogleCalendarDebugEnabled(accountId, coachId, body?.enabled !== false));
    }

    return json({ error: "not_found", message: "Google Calendar route not found." }, 404);
  } catch (error: any) {
    console.error("google_calendar:failed", action, error);
    const status = error?.status || 500;
    if (req.method === "GET" && action === "callback") {
      return html(callbackPage(false, error instanceof Error ? error.message : "Google Calendar connection failed."), status);
    }
    return json(
      {
        error: status === 500 ? "google_calendar_error" : "request_error",
        message: error instanceof Error ? error.message : "Google Calendar request failed.",
        failure: googleCalendarDebugErrorFromUnknown(error, action),
        request: error?.debugRequest || null,
      },
      status,
    );
  }
}

export const config: Config = {
  path: "/api/google-calendar/*",
};
