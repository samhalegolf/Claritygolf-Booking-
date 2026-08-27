import { getDatabase } from "@netlify/database";
import type { Config } from "@netlify/functions";

import { requireCoachActor } from "./_shared/coach-auth.mts";
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

/** Returns the signed-in admin's user id, or "" when the session is not valid. */
function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export default async function handler(req: Request) {
  // A push subscription belongs to one coach in one business: it is how that
  // business's booking alerts reach that device. Resolving the account
  // statically meant a second coach's device would have been registered
  // against the original business.
  let accountId = "";
  let userId = "";
  try {
    const actor = await requireCoachActor(req);
    accountId = actor.accountId;
    userId = actor.authUserId;
  } catch (error) {
    const status = (error as { status?: number })?.status === 403 ? 403 : 401;
    return json(
      {
        error: (error as { code?: string })?.code || "unauthorized",
        message: error instanceof Error ? error.message : "Admin login required.",
      },
      status,
    );
  }

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
