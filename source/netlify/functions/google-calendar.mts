import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";

import {
  createGoogleCalendarAuthUrl,
  disconnectGoogleCalendar,
  finishGoogleCalendarOAuth,
  getGoogleCalendarSyncStatus,
  syncGoogleCalendarNow,
  updateGoogleCalendarSyncSettings,
} from "./google-calendar-sync.mts";

const sessionCookieName = "clarity_session";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

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

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(
    cookieHeaderValue
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return index === -1
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
      }),
  );
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function supabase(table: string, query: string) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase GET ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabase(
    "admin_sessions",
    `select=id&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
  );
  return rows.length > 0;
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
      <a href="/?view=settings">Back to Clarity Booking</a>
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

    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);

    if (req.method === "GET" && action === "status") return json(await getGoogleCalendarSyncStatus(req));
    if ((req.method === "GET" || req.method === "POST") && action === "connect") return json(await createGoogleCalendarAuthUrl(req));
    if (req.method === "POST" && action === "sync") return json(await syncGoogleCalendarNow());
    if (req.method === "POST" && action === "disconnect") return json(await disconnectGoogleCalendar(req));
    if ((req.method === "PUT" || req.method === "POST") && action === "settings") {
      return json(await updateGoogleCalendarSyncSettings(await parseBody(req)));
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
      },
      status,
    );
  }
}

export const config: Config = {
  path: "/api/google-calendar/*",
};
