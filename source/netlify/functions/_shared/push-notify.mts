import { getDatabase } from "@netlify/database";
import { randomUUID } from "node:crypto";

/**
 * Web push transport for coach browser notifications.
 *
 * Deliberately transport only: storing subscriptions, sending, and pruning the
 * dead ones. Nothing here knows what a booking is. The message text is composed
 * in notification-engine.mts, which already owns every date/time label the
 * emails use — duplicating that formatting here would let the pop-up and the
 * email disagree about when a lesson is.
 *
 * Table is created on demand rather than by migration, matching
 * ensureOptixSyncTable: a feature table that must not 500 a fresh environment.
 */

export type StoredPushSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type CoachPushMessage = {
  title: string;
  body: string;
  /** In-app path opened when the notification is clicked. */
  url?: string;
  /** Notifications sharing a tag replace each other instead of stacking. */
  tag?: string;
};

export type CoachPushResult = {
  sent: number;
  failed: number;
  pruned: number;
  skipped?: "not_configured" | "no_subscriptions" | "library_missing";
};

function db() {
  return getDatabase();
}

function env(name: string, fallback = "") {
  return (globalThis.Netlify?.env?.get(name) || process.env[name] || fallback).trim();
}

export function pushPublicKey() {
  return env("VAPID_PUBLIC_KEY");
}

/**
 * VAPID needs a contact the push service can reach if a sender misbehaves.
 * Falls back to the address bookings already reply to.
 */
function vapidSubject() {
  const configured = env("VAPID_SUBJECT");
  if (configured) return configured;
  const email = env("NOTIFICATION_REPLY_TO") || env("RESEND_FROM_EMAIL");
  const address = email.includes("<") ? email.slice(email.indexOf("<") + 1, email.indexOf(">")) : email;
  return address ? `mailto:${address.trim()}` : "mailto:support@claritygolf.app";
}

export function pushConfigured() {
  return Boolean(env("VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY"));
}

let tableReady = false;

export async function ensurePushSubscriptionsTable() {
  if (tableReady) return;
  await db().sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ
    )
  `;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
    ON push_subscriptions (account_id)
  `;
  tableReady = true;
}

export async function listPushSubscriptions(accountId: string): Promise<StoredPushSubscription[]> {
  await ensurePushSubscriptionsTable();
  const rows = await db().sql`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE account_id = ${accountId}
    ORDER BY created_at ASC
  `;
  return rows.map((row: any) => ({
    id: String(row.id),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
  }));
}

export async function countPushSubscriptions(accountId: string) {
  await ensurePushSubscriptionsTable();
  const rows = await db().sql`
    SELECT COUNT(*)::int AS total FROM push_subscriptions WHERE account_id = ${accountId}
  `;
  return Number(rows[0]?.total || 0);
}

export async function hasPushSubscription(accountId: string, endpoint: string) {
  if (!endpoint) return false;
  await ensurePushSubscriptionsTable();
  const rows = await db().sql`
    SELECT 1 FROM push_subscriptions
    WHERE account_id = ${accountId} AND endpoint = ${endpoint}
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * One row per browser. The endpoint is the browser's own identifier for the
 * subscription, so upserting on it means re-enabling on the same device
 * refreshes the keys instead of leaving a stale duplicate behind — and every
 * duplicate would be a second identical pop-up.
 */
export async function savePushSubscription(input: {
  accountId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string;
}) {
  await ensurePushSubscriptionsTable();
  await db().sql`
    INSERT INTO push_subscriptions (id, account_id, user_id, endpoint, p256dh, auth, label)
    VALUES (
      ${`push-${randomUUID()}`},
      ${input.accountId},
      ${input.userId},
      ${input.endpoint},
      ${input.p256dh},
      ${input.auth},
      ${String(input.label || "").slice(0, 200)}
    )
    ON CONFLICT (endpoint) DO UPDATE SET
      account_id = EXCLUDED.account_id,
      user_id = EXCLUDED.user_id,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      label = EXCLUDED.label,
      failure_count = 0,
      last_error = '',
      last_seen_at = NOW()
  `;
}

export async function deletePushSubscription(accountId: string, endpoint: string) {
  if (!endpoint) return 0;
  await ensurePushSubscriptionsTable();
  const rows = await db().sql`
    DELETE FROM push_subscriptions
    WHERE account_id = ${accountId} AND endpoint = ${endpoint}
    RETURNING id
  `;
  return rows.length;
}

async function loadWebPush() {
  // Imported lazily so the tests, and every request path that never sends a
  // push, do not pay for it — and so a missing dependency degrades to "no
  // pop-up" instead of taking a booking down with it.
  const mod: any = await import("web-push");
  return (mod?.default ?? mod) as any;
}

/**
 * Send one message to every browser the coach has enabled.
 *
 * Never throws. A pop-up is a courtesy on top of the email that already went
 * out; nothing in the booking path should fail because a push service was
 * having a bad afternoon.
 */
export async function sendCoachPush(accountId: string, message: CoachPushMessage): Promise<CoachPushResult> {
  if (!pushConfigured()) return { sent: 0, failed: 0, pruned: 0, skipped: "not_configured" };

  let subscriptions: StoredPushSubscription[] = [];
  try {
    subscriptions = await listPushSubscriptions(accountId);
  } catch (error) {
    console.error("push_notify:list_failed", accountId, error);
    return { sent: 0, failed: 0, pruned: 0 };
  }
  if (!subscriptions.length) return { sent: 0, failed: 0, pruned: 0, skipped: "no_subscriptions" };

  let webPush: any;
  try {
    webPush = await loadWebPush();
    webPush.setVapidDetails(vapidSubject(), env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
  } catch (error) {
    console.error("push_notify:library_unavailable", error);
    return { sent: 0, failed: 0, pruned: 0, skipped: "library_missing" };
  }

  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    url: message.url || "/",
    tag: message.tag || "clarity-booking",
  });

  let sent = 0;
  let failed = 0;
  let pruned = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
          { TTL: 60 * 60 * 12, urgency: "high" },
        );
        sent += 1;
        await db().sql`
          UPDATE push_subscriptions
          SET last_sent_at = NOW(), failure_count = 0, last_error = ''
          WHERE id = ${subscription.id}
        `;
      } catch (error: any) {
        const status = Number(error?.statusCode || 0);
        // 404/410 is the push service telling us this browser is gone for good
        // (permission revoked, profile wiped, subscription expired). Anything
        // else — including 403, which usually means the VAPID keys changed —
        // is recorded but kept, because a config mistake must not silently
        // delete every device the coach registered.
        if (status === 404 || status === 410) {
          await db().sql`DELETE FROM push_subscriptions WHERE id = ${subscription.id}`;
          pruned += 1;
          return;
        }
        failed += 1;
        const reason = String(error?.body || error?.message || "push_failed").slice(0, 400);
        console.error("push_notify:send_failed", status, reason);
        await db().sql`
          UPDATE push_subscriptions
          SET failure_count = failure_count + 1, last_error = ${reason}
          WHERE id = ${subscription.id}
        `;
      }
    }),
  );

  console.log("push_notify:result", JSON.stringify({ accountId, sent, failed, pruned }));
  return { sent, failed, pruned };
}
