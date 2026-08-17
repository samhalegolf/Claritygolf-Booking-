import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import { defaultAccountId } from "./_shared/account.mts";
import {
  countPushSubscriptions,
  deletePushSubscription,
  hasPushSubscription,
  pushConfigured,
  pushPublicKey,
  savePushSubscription,
  sendCoachPush,
} from "./_shared/push-notify.mts";

/**
 * Browser notification subscriptions for the signed-in coach.
 *
 * GET    -> { configured, publicKey, subscribed, deviceCount }
 * POST   -> save this browser's subscription (upsert by endpoint)
 * POST   -> { test: true } sends a pop-up to every registered browser
 * DELETE -> forget this browser
 */

const SESSION_COOKIE = "clarity_session";

function db() {
  return getDatabase();
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseCookies(req: Request) {
  return Object.fromEntries(
    (req.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [decodeURIComponent(part), ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

/** Returns the signed-in admin's user id, or "" when the session is not valid. */
async function adminUserId(req: Request): Promise<string> {
  const token = parseCookies(req)[SESSION_COOKIE] || "";
  if (!token) return "";
  const { createHash } = await import("node:crypto");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const rows = await db().sql`
    SELECT user_id
    FROM admin_sessions
    WHERE token_hash = ${tokenHash}
      AND expires_at > NOW()
    LIMIT 1
  `;
  return String(rows[0]?.user_id || "");
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export default async function handler(req: Request) {
  const userId = await adminUserId(req);
  if (!userId) return json({ error: "unauthorized" }, 401);

  const accountId = defaultAccountId();

  if (req.method === "GET") {
    const endpoint = cleanText(new URL(req.url).searchParams.get("endpoint"), 600);
    try {
      return json({
        configured: pushConfigured(),
        publicKey: pushPublicKey(),
        // The browser asks "do you still know about me?" with its own
        // endpoint, so a wiped database or a subscription the coach removed
        // elsewhere shows as off rather than as a toggle that lies.
        subscribed: endpoint ? await hasPushSubscription(accountId, endpoint) : false,
        deviceCount: await countPushSubscriptions(accountId),
      });
    } catch (error) {
      console.error("push_subscriptions:status_failed", error);
      return json({ error: "status_failed", message: "Could not read notification settings." }, 500);
    }
  }

  if (req.method === "POST") {
    let body: any = null;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    if (body?.test === true) {
      if (!pushConfigured()) {
        return json(
          { error: "not_configured", message: "Browser notifications are not set up on the server yet." },
          503,
        );
      }
      const result = await sendCoachPush(accountId, {
        title: "Clarity test notification",
        body: "Browser notifications are working.\nThis is what a new booking will look like.",
        url: "/",
        tag: "clarity-test",
      });
      return json({ ok: result.sent > 0, ...result }, result.sent > 0 ? 200 : 207);
    }

    const endpoint = cleanText(body?.subscription?.endpoint, 600);
    const p256dh = cleanText(body?.subscription?.keys?.p256dh, 300);
    const auth = cleanText(body?.subscription?.keys?.auth, 300);
    if (!endpoint || !p256dh || !auth) {
      return json({ error: "invalid_subscription", message: "The browser did not supply a usable subscription." }, 400);
    }

    try {
      await savePushSubscription({
        accountId,
        userId,
        endpoint,
        p256dh,
        auth,
        label: cleanText(body?.label, 200) || cleanText(req.headers.get("user-agent"), 200),
      });
      return json({ ok: true, deviceCount: await countPushSubscriptions(accountId) });
    } catch (error) {
      console.error("push_subscriptions:save_failed", error);
      return json({ error: "save_failed", message: "Could not save this browser." }, 500);
    }
  }

  if (req.method === "DELETE") {
    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const endpoint = cleanText(body?.endpoint, 600);
    if (!endpoint) return json({ error: "invalid_endpoint" }, 400);
    try {
      const removed = await deletePushSubscription(accountId, endpoint);
      return json({ ok: true, removed, deviceCount: await countPushSubscriptions(accountId) });
    } catch (error) {
      console.error("push_subscriptions:delete_failed", error);
      return json({ error: "delete_failed", message: "Could not remove this browser." }, 500);
    }
  }

  return json({ error: "method_not_allowed" }, 405);
}

export const config: Config = { path: "/api/push-subscriptions" };
