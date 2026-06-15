import type { Config } from "@netlify/functions";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";

const sessionCookieName = "clarity_session";
const sessionDays = 7;

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
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

function cleanEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 180) : "";
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const passwordHash = scryptSync(password, salt, 64).toString("hex");
  return { passwordHash, salt };
}

function cookieHeader(token: string, req: Request, maxAgeSeconds: number) {
  const secure = new URL(req.url).protocol === "https:";
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured for admin login.");
  return { url, key };
}

async function supabaseRequest(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await parseBody(req);
    const email = cleanEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const adminEmail = cleanEmail(env("CLARITY_ADMIN_EMAIL"));
    const adminPassword = env("CLARITY_ADMIN_PASSWORD");

    if (!adminEmail || !adminPassword || email !== adminEmail || password !== adminPassword) {
      return json({ error: "invalid_login", message: "Email or password is incorrect." }, 401);
    }

    const userId = `env-admin-${hashToken(adminEmail).slice(0, 24)}`;
    const { passwordHash, salt } = hashPassword(adminPassword);
    await supabaseRequest("admin_users", {
      method: "POST",
      query: "on_conflict=email",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: [
        {
          id: userId,
          email: adminEmail,
          password_hash: passwordHash,
          password_salt: salt,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
    await supabaseRequest("admin_sessions", {
      method: "POST",
      prefer: "return=minimal",
      body: [
        {
          id: randomUUID(),
          token_hash: hashToken(token),
          user_id: userId,
          expires_at: expiresAt,
          created_at: new Date().toISOString(),
        },
      ],
    });

    return json(
      { authenticated: true, email: adminEmail, expiresAt },
      200,
      { "Set-Cookie": cookieHeader(token, req, sessionDays * 24 * 60 * 60) },
    );
  } catch (error) {
    console.error("auth_login:failed", error);
    return json(
      {
        error: "auth_login_error",
        message: error instanceof Error ? error.message : "Could not complete login.",
      },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/auth/login",
};
