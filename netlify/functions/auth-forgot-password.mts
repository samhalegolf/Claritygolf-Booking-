import type { Config } from "@netlify/functions";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { supabaseRequest } from "./supabase-client.mjs";

const passwordResetMinutes = 30;
function env(name: string, fallback = "") { return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
function cleanEmail(value: unknown) { return typeof value === "string" ? value.trim().toLowerCase().slice(0, 180) : ""; }
function hashToken(token: string) { return createHash("sha256").update(token).digest("hex"); }
async function parseBody(req: Request) { const raw = await req.text(); return raw ? JSON.parse(raw) : {}; }
function resetUrl(req: Request, token: string) {
  const url = new URL(req.url);
  const appUrl = env("CLARITY_APP_URL", `${url.protocol}//${url.host}`);
  const reset = new URL(appUrl);
  reset.searchParams.set("reset", token);
  return reset.toString();
}
async function sendEmail(to: string, resetLink: string) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return false;
  const from = env("CLARITY_EMAIL_FROM", "Clarity Golf Booking <bookings@claritygolf.app>");
  const replyTo = env("CLARITY_REPLY_TO_EMAIL", env("CLARITY_ADMIN_EMAIL", ""));
  const subject = "Clarity Golf Booking password reset";
  const html = `<p>Use this link to reset your Clarity Golf Booking password. It expires in ${passwordResetMinutes} minutes.</p><p><a href="${resetLink}">${resetLink}</a></p>`;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to, subject, html, reply_to: replyTo || undefined }) });
  if (!response.ok) { console.error("auth_forgot_password:resend_failed", response.status, await response.text()); return false; }
  return true;
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await parseBody(req);
    const email = cleanEmail(body.email);
    const adminEmail = cleanEmail(env("CLARITY_ADMIN_EMAIL"));
    if (!email || email !== adminEmail) return json({ ok: true, message: "If that email matches the coach account, a reset link has been sent." });

    let users = await supabaseRequest("admin_users", { purpose: "Supabase password reset", query: `select=id,email&email=eq.${encodeURIComponent(email)}&limit=1` });
    if (!users.length) {
      const userId = `env-admin-${hashToken(adminEmail).slice(0, 24)}`;
      await supabaseRequest("admin_users", { purpose: "Supabase password reset", method: "POST", prefer: "return=minimal", body: [{ id: userId, email: adminEmail, password_hash: "pending", password_salt: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] });
      users = [{ id: userId, email: adminEmail }];
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + passwordResetMinutes * 60 * 1000).toISOString();
    await supabaseRequest("admin_password_resets", { purpose: "Supabase password reset", method: "POST", prefer: "return=minimal", body: [{ id: randomUUID(), token_hash: hashToken(token), user_id: users[0].id, expires_at: expiresAt, created_at: new Date().toISOString() }] });
    const sent = await sendEmail(email, resetUrl(req, token));
    if (!sent) return json({ ok: false, message: "Could not send the reset email. Check Resend settings." }, 502);
    return json({ ok: true, message: "If that email matches the coach account, a reset link has been sent." });
  } catch (error) {
    console.error("auth_forgot_password:failed", error);
    return json({ ok: false, message: error instanceof Error ? error.message : "Could not send reset email." }, 500);
  }
}

export const config: Config = { path: "/api/auth/forgot-password" };
