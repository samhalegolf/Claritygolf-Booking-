import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import { supabaseRequest } from "./supabase-client.mjs";

const sessionCookieName = "clarity_session";

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } });
}
function clearSessionCookie() { return `${sessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(cookieHeaderValue.split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const index = pair.indexOf("=");
    return index === -1 ? [decodeURIComponent(pair), ""] : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
  }));
}

export default async function handler(req: Request) {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return json({ authenticated: false });
  try {
    const sessions = await supabaseRequest("admin_sessions", {
      purpose: "Supabase admin session",
      query: `select=id,user_id,expires_at&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
    });
    const session = sessions[0];
    if (!session) return json({ authenticated: false }, 200, { "Set-Cookie": clearSessionCookie() });
    const users = await supabaseRequest("admin_users", { purpose: "Supabase admin session", query: `select=id,email&id=eq.${encodeURIComponent(session.user_id)}&limit=1` });
    const user = users[0];
    if (!user) return json({ authenticated: false }, 200, { "Set-Cookie": clearSessionCookie() });
    return json({ authenticated: true, email: user.email });
  } catch (error) {
    console.error("auth_session:failed", error);
    return json({ authenticated: false, sessionRestoreFailed: true, message: error instanceof Error ? error.message : "Session check failed." }, 200, { "Set-Cookie": clearSessionCookie() });
  }
}

export const config: Config = { path: "/api/auth/session" };
