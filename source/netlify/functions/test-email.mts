import type { Config } from "@netlify/functions";
import { createHash, randomUUID } from "node:crypto";

const sessionCookieName = "clarity_session";

function env(name: string, fallback = "") {
  return globalThis.Netlify?.env?.get(name) || process.env[name] || fallback;
}

function emailNotificationsGloballyDisabled() {
  return ["0", "false", "off", "disabled", "no"].includes(env("EMAIL_NOTIFICATIONS_ENABLED", "").trim().toLowerCase());
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

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  const email = cleanString(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
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

async function supabase(table: string, options: { method?: string; query?: string; body?: unknown; prefer?: string } = {}) {
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

async function requireAdmin(req: Request) {
  const token = parseCookies(req)[sessionCookieName] || "";
  if (!token) return false;
  const rows = await supabase("admin_sessions", {
    query: `select=id&token_hash=eq.${encodeURIComponent(hashToken(token))}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`,
  });
  return rows.length > 0;
}

async function parseBody(req: Request) {
  const raw = await req.text();
  return raw ? JSON.parse(raw) : {};
}

async function recordNotification(record: Record<string, unknown>) {
  await supabase("notification_history", {
    method: "POST",
    prefer: "return=minimal",
    body: [record],
  });
}

export default async function handler(req: Request) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    if (!(await requireAdmin(req))) return json({ error: "unauthorized", message: "Admin login required." }, 401);

    const body = await parseBody(req);
    const recipient = cleanEmail(body.email);
    if (!recipient) return json({ error: "missing_email", message: "Enter an email address to send the test to." }, 400);
    if (emailNotificationsGloballyDisabled()) {
      return json(
        {
          ok: false,
          message: "Email notifications are disabled by EMAIL_NOTIFICATIONS_ENABLED.",
        },
        503,
      );
    }

    const apiKey = env("RESEND_API_KEY");
    if (!apiKey) {
      return json({ ok: false, message: "Resend API key is missing in Netlify functions environment." }, 502);
    }

    const from = env("CLARITY_EMAIL_FROM", "Clarity Golf Booking <onboarding@resend.dev>");
    const replyTo = env("CLARITY_REPLY_TO_EMAIL", env("CLARITY_NOTIFICATION_EMAIL", ""));
    const subject = "Clarity Golf booking email test";
    const text = "This is a test email from the Clarity Golf booking system.";
    const html = `<p>${text}</p><p>If you received this, the booking system can connect to Resend.</p>`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `test-email-${Date.now()}-${randomUUID()}`,
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    const responseText = await response.text();
    let data: any = {};
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = { raw: responseText };
    }

    const notificationId = randomUUID();
    await recordNotification({
      id: notificationId,
      person_key: recipient,
      calendar_item_id: null,
      recipient,
      subject,
      kind: "test_client_email",
      status: response.ok ? "sent_to_provider" : "failed",
      provider: "resend",
      provider_id: response.ok ? data?.id || "" : "",
      error: response.ok ? null : JSON.stringify(data).slice(0, 1000),
      created_at: new Date().toISOString(),
    });

    if (!response.ok) {
      return json(
        {
          ok: false,
          message: data?.message || data?.error || "Resend rejected the email.",
          resendStatus: response.status,
          resend: data,
        },
        502,
      );
    }

    return json({
      ok: true,
      message: "Test email sent to Resend.",
      results: [
        {
          channel: "client",
          recipient,
          subject,
          kind: "test_client_email",
          status: "sent_to_provider",
          sent: true,
          id: data?.id || "",
        },
      ],
    });
  } catch (error) {
    console.error("test_email:failed", error);
    return json(
      { ok: false, message: error instanceof Error ? error.message : "Could not send test email." },
      500,
    );
  }
}

export const config: Config = {
  path: "/api/test-email",
};
