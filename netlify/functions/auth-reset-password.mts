import type { Config } from "@netlify/functions";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";

const sessionCookieName = "clarity_session";
const sessionDays = 7;

function env(name: string, fallback = "") { return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback; }
function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } });
}
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function hashPassword(password: string, salt = randomBytes(16).toString("hex")) { return { passwordHash: scryptSync(password, salt, 64).toString("hex"), salt }; }
function cookieHeader(token: string, req: Request, maxAgeSeconds: number) {
  const secure = new URL(req.url).protocol === "https:";
  return [`${sessionCookieName}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`, secure ? "Secure" : ""].filter(Boolean).join("; ");
}
function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}
async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
  const { url, key } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/${table}${options.query ? `?${options.query}` : ""}`, {
    method: options.method || "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(options.prefer ? { Prefer: options.prefer } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${options.method || "GET"} ${table} failed ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : [];
}
async function parseBody(req: Request) { const raw = await req.text(); return raw ? JSON.parse(raw) : {}; }

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await parseBody(req);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!token || password.length < 8) return json({ error: "weak_password", message: "Use at least 8 characters." }, 400);
    const rows = await supabase("admin_password_resets", {
      query: `select=id,user_id,expires_at,used_at&token_hash=eq.${encodeURIComponent(hashToken(token))}&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    });
    const reset = rows[0];
    if (!reset) return json({ error: "invalid_token", message: "This reset link has expired or has already been used." }, 400);
    const { passwordHash, salt } = hashPassword(password);
    await supabase("admin_users", { method: "PATCH", query: `id=eq.${encodeURIComponent(reset.user_id)}`, prefer: "return=minimal", body: { password_hash: passwordHash, password_salt: salt, updated_at: new Date().toISOString() } });
    await supabase("admin_password_resets", { method: "PATCH", query: `id=eq.${encodeURIComponent(reset.id)}`, prefer: "return=minimal", body: { used_at: new Date().toISOString() } });
    const users = await supabase("admin_users", { query: `select=id,email&id=eq.${encodeURIComponent(reset.user_id)}&limit=1` });
    const user = users[0];
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
    await supabase("admin_sessions", { method: "POST", prefer: "return=minimal", body: [{ id: randomUUID(), token_hash: hashToken(sessionToken), user_id: reset.user_id, expires_at: expiresAt, created_at: new Date().toISOString() }] });
    return json({ authenticated: true, email: user?.email || env("CLARITY_ADMIN_EMAIL", ""), expiresAt }, 200, { "Set-Cookie": cookieHeader(sessionToken, req, sessionDays * 24 * 60 * 60) });
  } catch (error) {
    console.error("auth_reset_password:failed", error);
    return json({ error: "reset_failed", message: error instanceof Error ? error.message : "Could not reset password." }, 500);
  }
}

export const config: Config = { path: "/api/auth/reset-password" };
