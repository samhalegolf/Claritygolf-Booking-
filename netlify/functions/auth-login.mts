import type { Config } from "@netlify/functions";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { supabaseRequest } from "./supabase-client.mjs";

const sessionCookieName = "clarity_session";
const sessionDays = 7;

function env(name: string, fallback = "") { return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback; }
function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } });
}
function cleanEmail(value: unknown) { return typeof value === "string" ? value.trim().toLowerCase().slice(0, 180) : ""; }
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function hashPassword(password: string, salt = randomBytes(16).toString("hex")) { return { passwordHash: scryptSync(password, salt, 64).toString("hex"), salt }; }
function verifyPassword(password: string, passwordHash: string, passwordSalt: string) {
  if (!password || !passwordHash || !passwordSalt) return false;
  try {
    const attempt = Buffer.from(hashPassword(password, passwordSalt).passwordHash, "hex");
    const saved = Buffer.from(passwordHash, "hex");
    return attempt.length === saved.length && timingSafeEqual(attempt, saved);
  } catch { return false; }
}
function cookieHeader(token: string, req: Request, maxAgeSeconds: number) {
  const secure = new URL(req.url).protocol === "https:";
  return [`${sessionCookieName}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`, secure ? "Secure" : ""].filter(Boolean).join("; ");
}
async function parseBody(req: Request) { const raw = await req.text(); return raw ? JSON.parse(raw) : {}; }
async function findAdminUser(email: string) {
  const rows = await supabaseRequest("admin_users", { purpose: "Supabase admin login", query: `select=id,email,password_hash,password_salt&email=eq.${encodeURIComponent(email)}&limit=1` });
  return rows[0] || null;
}
async function upsertAdminUser(email: string, password: string) {
  const { passwordHash, salt } = hashPassword(password);
  const id = `env-admin-${hashToken(email).slice(0, 24)}`;
  await supabaseRequest("admin_users", {
    purpose: "Supabase admin login",
    method: "POST",
    query: "on_conflict=email",
    prefer: "resolution=merge-duplicates,return=representation",
    body: [{ id, email, password_hash: passwordHash, password_salt: salt, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  });
  return { id, email };
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await parseBody(req);
    const email = cleanEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const adminEmail = cleanEmail(env("CLARITY_ADMIN_EMAIL"));
    const adminPassword = env("CLARITY_ADMIN_PASSWORD");
    if (!adminEmail) return json({ error: "auth_env_error", message: "CLARITY_ADMIN_EMAIL is not configured in Netlify." }, 500);
    if (!email || email !== adminEmail) return json({ error: "invalid_login", message: "Email or password is incorrect." }, 401);

    let user = await findAdminUser(email);
    const hasStoredPassword = Boolean(user?.password_hash && user?.password_salt && user.password_hash !== "pending" && user.password_salt !== "pending");
    if (hasStoredPassword) {
      if (!verifyPassword(password, user.password_hash, user.password_salt)) return json({ error: "invalid_login", message: "Email or password is incorrect." }, 401);
    } else {
      if (!adminPassword || password !== adminPassword) return json({ error: "invalid_login", message: "Email or password is incorrect." }, 401);
      user = await upsertAdminUser(adminEmail, adminPassword);
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
    await supabaseRequest("admin_sessions", {
      purpose: "Supabase admin login",
      method: "POST",
      prefer: "return=minimal",
      body: [{ id: randomUUID(), token_hash: hashToken(token), user_id: user?.id || `env-admin-${hashToken(adminEmail).slice(0, 24)}`, expires_at: expiresAt, created_at: new Date().toISOString() }],
    });
    return json({ authenticated: true, email: adminEmail, expiresAt }, 200, { "Set-Cookie": cookieHeader(token, req, sessionDays * 24 * 60 * 60) });
  } catch (error) {
    console.error("auth_login:failed", error);
    return json({ error: "auth_login_error", message: error instanceof Error ? error.message : "Could not complete login." }, 500);
  }
}

export const config: Config = { path: "/api/auth/login" };
