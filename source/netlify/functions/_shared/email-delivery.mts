// The one place this app hands an email to a provider.
//
// Before this module there were seven `fetch("https://api.resend.com/emails")`
// call sites and two separate `sendEmail()` implementations. They had drifted:
// notification-engine spaced consecutive sends 600ms apart and retried a 429,
// because a booking fires client + coach + admin back to back and Resend allows
// two requests a second; booking-core did neither, so password resets and
// booking confirmations had different reliability for no reason anyone chose.
// The five smaller sites each rebuilt the From header their own way, and three
// of them signed every workspace's mail "Clarity Golf".
//
// One function now owns all of it: the throttle, the 429 retry, the From header,
// the idempotency key, and what "not configured" means.
//
// It is a boundary module in the same sense as stripe.mts and google-provider.mts
// -- it is the edge of the application, where something leaves Clarity. Anything
// that has to happen to *every* outbound email belongs here and nowhere else.
// Sandbox Mode's capture is the next thing to land in it: one branch in this
// file rather than seven.
//
// billing-api.mts imports this despite its "no booking/notification code" rule.
// That rule is about who owns booking and calendar behaviour; this is the same
// category as the _shared/stripe.mts it already imports.

import { getDatabase } from "./database.mts";

function env(name: string, fallback = ""): string {
  return (
    (globalThis as unknown as { Netlify?: { env?: { get: (n: string) => string } } })
      .Netlify?.env?.get(name) ||
    (process.env[name] as string | undefined) ||
    fallback
  );
}

function cleanText(value: unknown, fallback = "", max = 800): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function cleanEmail(value: unknown, fallback = ""): string {
  const email = cleanText(value, "", 180).toLowerCase();
  return email.includes("@") ? email : fallback;
}

/** Pulls the bare address out of a "Name <addr@host>" header, or "" if there isn't one. */
function emailAddressFromHeader(fromHeader: string): string {
  const rawFrom = cleanText(fromHeader, "", 512);
  if (!rawFrom) return "";
  const matched = rawFrom.match(/^\s*(?:"[^"]*"|[^<"]*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (matched) {
    const address = cleanEmail(matched[1], "");
    if (address) return address;
  }
  return cleanEmail(rawFrom, "");
}

function quoteAddressName(name: string): string {
  const trimmed = cleanText(name, "", 160);
  if (!trimmed) return "";
  const sanitized = trimmed.replace(/"/g, '\\"');
  return /[<>"]/.test(trimmed) ? `"${sanitized}"` : sanitized;
}

function formatFromHeader(name: string, fallbackAddress: string, sourceHeader: string): string {
  const address = emailAddressFromHeader(sourceHeader) || fallbackAddress;
  if (!address) return "";
  const quotedName = quoteAddressName(name);
  return quotedName ? `${quotedName} <${address}>` : address;
}

/**
 * A kill switch for the whole deployment, not a per-account setting.
 *
 * Lived in booking-core and applied to exactly one of the seven senders, so
 * turning email off left five of them still sending. It applies to all of them
 * from here.
 */
export function emailNotificationsGloballyDisabled(): boolean {
  return ["0", "false", "off", "disabled", "no"].includes(
    env("EMAIL_NOTIFICATIONS_ENABLED", "").trim().toLowerCase(),
  );
}

// Resend allows 2 requests/second. Process-wide rather than per-account on
// purpose: the limit belongs to the API key, and one warm instance sending for
// two businesses at once would otherwise sail past it.
const SEND_MIN_INTERVAL_MS = 600;
let lastSendAt = 0;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleSend() {
  const elapsed = Date.now() - lastSendAt;
  if (elapsed < SEND_MIN_INTERVAL_MS) await wait(SEND_MIN_INTERVAL_MS - elapsed);
  lastSendAt = Date.now();
}

/**
 * The three settings keys that decide who an email is from.
 *
 * Read straight from Postgres rather than through either caller's settings
 * layer, because the two callers have different ones (booking-core's
 * readSettings, notification-engine's REST helper) and this module must not
 * depend on either. Account-scoped like every other settings read -- an
 * unscoped one returns a row per business per key and the last one wins, which
 * is how a second workspace's mail came to be signed "Sam Hale Golf".
 */
async function fromIdentity(accountId: string): Promise<{
  businessName: string;
  coachName: string;
  notificationFromName: string;
}> {
  const blank = { businessName: "", coachName: "", notificationFromName: "" };
  if (!accountId) return blank;
  try {
    const rows = await getDatabase().sql<{ key: string; value: string }[]>`
      SELECT key, value FROM settings
      WHERE account_id = ${accountId}
        AND key IN ('accountBusinessName', 'accountCoachName', 'notificationFromName')
    `;
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      businessName: cleanText(map.accountBusinessName, env("CLARITY_BUSINESS_NAME", ""), 120),
      coachName: cleanText(map.accountCoachName, env("CLARITY_COACH_NAME", ""), 120),
      notificationFromName: cleanText(map.notificationFromName, "", 120),
    };
  } catch {
    // A settings read that fails is not a reason to drop the email. The From
    // header falls back to the environment's, which is always deliverable.
    return blank;
  }
}

export type EmailAttachment = {
  filename: string;
  /** Base64. The caller encodes -- this module does not know what a PDF is. */
  content: string;
};

export type DeliverEmailInput = {
  /** Whose business this is sent as. Decides the From header. */
  accountId: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  /** Resend dedupes on this. Strongly preferred -- retries are cheap, doubles aren't. */
  idempotencyKey?: string;
  attachments?: EmailAttachment[];
  /**
   * Overrides the settings-derived display name.
   *
   * For mail that is from Clarity rather than from the business -- the system
   * smoke test, and nothing else so far. A booking email must never pass this.
   */
  fromName?: string;
};

/**
 * Deliberately one flat shape rather than a discriminated union on `sent`.
 *
 * Every caller spreads this straight into a notification_history row and then
 * reads `reason` and `id` off it regardless of outcome. A union would make each
 * of those an error and buy nothing: the fields are optional in practice.
 */
export type EmailDeliveryResult = {
  sent: boolean;
  /** Resend's message id, when it accepted the send. */
  id?: string;
  /** Why not, in one machine-readable token. Recorded in notification_history. */
  reason?: string;
  /** The provider's own words. "resend_failed" alone made 429s undiagnosable. */
  error?: string;
  status?: number;
};

/**
 * Send one email.
 *
 * Never throws for an ordinary failure -- a missing key, no recipient, a refusal
 * from Resend all come back as `{ sent: false, reason }`, because every caller
 * is doing something else at the time (confirming a booking, issuing an invoice)
 * and an undeliverable email must not unwind that work. Callers that genuinely
 * need a throw, like the invoice sender, check `sent` and raise their own.
 */
export async function deliverEmail(input: DeliverEmailInput): Promise<EmailDeliveryResult> {
  if (emailNotificationsGloballyDisabled()) {
    return { sent: false, reason: "email_notifications_disabled" };
  }

  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) return { sent: false, reason: "missing_resend_key" };

  const recipients = (Array.isArray(input.to) ? input.to : [input.to])
    .map((value) => cleanEmail(value, ""))
    .filter(Boolean);
  if (!recipients.length) return { sent: false, reason: "missing_recipient" };

  const identity = await fromIdentity(input.accountId);
  const rawFromHeader = env(
    "CLARITY_EMAIL_FROM",
    `${identity.businessName || "Clarity Golf"} <onboarding@resend.dev>`,
  );
  // The business's own name, never the product's, unless nothing else is set.
  const fromName =
    cleanText(input.fromName, "", 120) ||
    identity.notificationFromName ||
    identity.coachName ||
    identity.businessName ||
    "Clarity Golf";
  const from = formatFromHeader(
    fromName,
    cleanEmail(rawFromHeader, env("CLARITY_NOTIFICATION_EMAIL", "")),
    rawFromHeader,
  );

  const payload = JSON.stringify({
    from,
    to: recipients,
    subject: input.subject,
    ...(input.html ? { html: input.html } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });

  const attempt = async () => {
    await throttleSend();
    return fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: payload,
    });
  };

  let response: Response;
  try {
    response = await attempt();
    // Rate limited despite the spacing -- another instance is sending too.
    if (response.status === 429) {
      await wait(1200);
      response = await attempt();
    }
  } catch (error) {
    return {
      sent: false,
      reason: "resend_unreachable",
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }

  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      sent: false,
      reason: `resend_failed_${response.status}`,
      error: responseText.slice(0, 1000),
      status: response.status,
    };
  }
  try {
    return { sent: true, id: (responseText ? JSON.parse(responseText)?.id : "") || "" };
  } catch {
    return { sent: true, id: "" };
  }
}
