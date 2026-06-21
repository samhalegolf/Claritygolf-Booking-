import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";

const sessionCookieName = "clarity_session";
const sessionLookupTimeoutMs = 2500;

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function autoSessionRestoreEnabled() {
  return env("CLARITY_AUTO_SESSION_RESTORE_ENABLED", "0") === "1";
}

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function clearSessionCookie() {
  return `${sessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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

async function supabaseGet(table: string, query: string) {
  const { url, key } = supabaseConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), sessionLookupTimeoutMs);
  try {
    const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase GET ${table} failed ${response.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : [];
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req: Request) {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const token = parseCookies(req)[sessionCookieName] || "";

  // Temporary production safety switch. Manual login remains enabled and still
  // creates the secure cookie used by the protected calendar/settings APIs.
  // Page refreshes simply return to the login form until this flag is set to 1.
  if (!autoSessionRestoreEnabled()) {
    return json(
      { authenticated: false, autoSessionRestoreDisabled: true },
      200,
      token ? { "Set-Cookie": clearSessionCookie() } : {},
    );
  }

  if (!token) return json({ authenticated: false });

  try {
    const sessions = await supabaseGet(
      "admin_sessions",
      `select=id,user_id,expires_at&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    );
    const session = sessions[0];
    if (!session) return json({ authenticated: false }, 200, { "Set-Cookie": clearSessionCookie() });

    const users = await supabaseGet(
      "admin_users",
      `select=id,email&id=eq.${encodeURIComponent(session.user_id)}&limit=1`,
    );
    const user = users[0];
    if (!user) return json({ authenticated: false }, 200, { "Set-Cookie": clearSessionCookie() });
    return json({ authenticated: true, email: user.email });
  } catch (error) {
    console.error("auth_session:failed", error);
    // A stale browser cookie must never trap the UI on “Checking”. Treat a
    // timed-out or failed restoration as logged out and clear the cookie.
    return json(
      {
        authenticated: false,
        sessionRestoreFailed: true,
        message: error instanceof Error ? error.message : "Session check failed.",
      },
      200,
      { "Set-Cookie": clearSessionCookie() },
    );
  }
}

export const config: Config = {
  path: "/api/auth/session",
};
