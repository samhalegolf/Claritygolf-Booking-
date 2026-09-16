import type { Config } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { deliverEmail, emailNotificationsGloballyDisabled } from "./_shared/email-delivery.mts";


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

function cleanString(value: unknown, fallback = "", max = 600) {
  return typeof value === "string" ? value.trim().slice(0, max) || fallback : fallback;
}

function cleanEmail(value: unknown, fallback = "") {
  const email = cleanString(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
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

/**
 * A test send writes a notification_history row, and that table is
 * account-owned now, so this needs the business -- not just "a session row
 * exists", which is all the old check established.
 */
async function requireAccountId(req: Request): Promise<string> {
  return (await requireCoachActor(req)).accountId;
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
    const accountId = await requireAccountId(req);

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

    const replyTo = env("CLARITY_REPLY_TO_EMAIL", env("CLARITY_NOTIFICATION_EMAIL", ""));
    const subject = "Clarity Golf booking email test";
    const text = "This is a test email from the Clarity Golf booking system.";
    const html = `<p>${text}</p><p>If you received this, the booking system can connect to Resend.</p>`;

    // Through the same sender every real email uses. A hand-rolled fetch here
    // could pass while the actual sending path was broken, which is the one
    // thing a test-send must not do.
    const result = await deliverEmail({
      accountId,
      to: recipient,
      subject,
      html,
      text,
      replyTo: replyTo || undefined,
      idempotencyKey: `test-email-${Date.now()}-${randomUUID()}`,
    });

    await recordNotification({
      id: randomUUID(),
      account_id: accountId,
      person_key: recipient,
      calendar_item_id: null,
      recipient,
      subject,
      kind: "test_client_email",
      status: result.sent ? "sent_to_provider" : "failed",
      provider: "resend",
      provider_id: result.id || "",
      error: result.sent ? null : [result.reason, result.error].filter(Boolean).join(": ").slice(0, 1000),
      created_at: new Date().toISOString(),
    });

    if (!result.sent) {
      if (result.reason === "missing_resend_key") {
        return json({ ok: false, message: "Resend API key is missing in Netlify functions environment." }, 502);
      }
      return json(
        {
          ok: false,
          message: result.error || "Resend rejected the email.",
          resendStatus: result.status,
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
          id: result.id || "",
        },
      ],
    });
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return json(
        {
          ok: false,
          error: (error as { code?: string })?.code || "unauthorized",
          message: error instanceof Error ? error.message : "Admin login required.",
        },
        status,
      );
    }
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
