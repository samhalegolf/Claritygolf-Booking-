import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";

const sessionCookieName = "clarity_session";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
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

async function supabaseGet(table: string, query: string) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase GET ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

export default async function handler(req: Request) {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  try {
    const token = parseCookies(req)[sessionCookieName] || "";
    if (!token) return json({ authenticated: false });

    const sessions = await supabaseGet(
      "admin_sessions",
      `select=id,user_id,expires_at&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    );
    const session = sessions[0];
    if (!session) return json({ authenticated: false });

    const users = await supabaseGet(
      "admin_users",
      `select=id,email&id=eq.${encodeURIComponent(session.user_id)}&limit=1`,
    );
    const user = users[0];
    return json(user ? { authenticated: true, email: user.email } : { authenticated: false });
  } catch (error) {
    console.error("auth_session:failed", error);
    return json({ authenticated: false, message: error instanceof Error ? error.message : "Session check failed." }, 500);
  }
}

export const config: Config = {
  path: "/api/auth/session",
};
