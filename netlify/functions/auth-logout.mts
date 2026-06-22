import type { Config } from "@netlify/functions";
import { createHash } from "node:crypto";
import { supabaseRequest } from "./supabase-client.mjs";

const sessionCookieName = "clarity_session";
function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } }); }
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
function parseCookies(req: Request) {
  const cookieHeaderValue = req.headers.get("cookie") || "";
  return Object.fromEntries(cookieHeaderValue.split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const index = pair.indexOf("=");
    return index === -1 ? [decodeURIComponent(pair), ""] : [decodeURIComponent(pair.slice(0, index)), decodeURIComponent(pair.slice(index + 1))];
  }));
}
function clearCookieHeader() { return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; }
async function deleteSession(token: string) {
  if (!token) return;
  await supabaseRequest("admin_sessions", { purpose: "Supabase admin logout", method: "DELETE", query: `token_hash=eq.${encodeURIComponent(hashToken(token))}`, prefer: "return=minimal" });
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = parseCookies(req)[sessionCookieName] || "";
  await deleteSession(token).catch((error) => console.warn("auth_logout:delete_failed", error));
  return json({ authenticated: false }, 200, { "Set-Cookie": clearCookieHeader() });
}

export const config: Config = { path: "/api/auth/logout" };
