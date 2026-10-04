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
  updatePushSubscriptionLanguage,
} from "./_shared/push-notify.mts";
import { messageText } from "./_shared/message-language.mts";
import {
  apnsConfigured,
  cleanNativePlatform,
  countNativePushDevices,
  deleteNativePushDevice,
  fcmConfigured,
  hasNativePushDevice,
  nativePushConfigured,
  saveNativePushDevice,
} from "./_shared/native-push.mts";
import { cleanString } from "./_shared/values.mts";
import { json } from "./_shared/http.mts";

/**
 * Browser notification subscriptions for the signed-in coach.
 *
 * GET    -> { configured, publicKey, subscribed, deviceCount }
 * POST   -> save this browser's subscription (upsert by endpoint)
 * POST   -> { test: true } sends a pop-up to every registered browser
 * POST   -> { endpoint, language } this browser now reads another language
 * DELETE -> forget this browser
 *
 * The staff app's phones use the same route with a push token instead of a
 * browser subscription (see _shared/native-push.mts):
 * GET    ?nativeToken=  -> also { native: { ios, android }, nativeRegistered }
 * POST   { native: { platform, token, language } } -> save this phone
 * DELETE { nativeToken } -> forget this phone
 */
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
    const params = new URL(req.url).searchParams;
    const endpoint = cleanString(params.get("endpoint"), "", 600);
    const nativeToken = cleanString(params.get("nativeToken"), "", 600);
    try {
      return json({
        configured: pushConfigured(),
        // Which halves of phone push the server can send, so the app only
        // offers alerts on a phone the server can actually reach.
        native: { ios: apnsConfigured(), android: fcmConfigured() },
        nativeRegistered: nativeToken ? await hasNativePushDevice(accountId, nativeToken) : false,
        publicKey: pushPublicKey(),
        // The browser asks "do you still know about me?" with its own
        // endpoint, so a wiped database or a subscription the coach removed
        // elsewhere shows as off rather than as a toggle that lies.
        subscribed: endpoint ? await hasPushSubscription(accountId, endpoint) : false,
        deviceCount: (await countPushSubscriptions(accountId)) + (await countNativePushDevices(accountId)),
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
      if (!pushConfigured() && !nativePushConfigured()) {
        return json(
          { error: "not_configured", message: "Browser notifications are not set up on the server yet." },
          503,
        );
      }
      const result = await sendCoachPush(accountId, (language) => {
        const mt = messageText(language);
        return {
          title: mt("Clarity test notification"),
          body: mt("Browser notifications are working.\nThis is what a new booking will look like."),
          url: "/",
          tag: "clarity-test",
        };
      });
      return json({ ok: result.sent > 0, ...result }, result.sent > 0 ? 200 : 207);
    }

    if (body?.native) {
      const platform = cleanNativePlatform(body.native.platform);
      const token = cleanString(body.native.token, "", 600);
      if (!platform || !token) {
        return json({ error: "invalid_device", message: "The app did not supply a usable push token." }, 400);
      }
      try {
        await saveNativePushDevice({
          accountId,
          userId,
          platform,
          token,
          language: body.native.language,
          label: cleanString(body?.label, "", 200) || cleanString(req.headers.get("user-agent"), "", 200),
        });
        return json({ ok: true });
      } catch (error) {
        console.error("push_subscriptions:native_save_failed", error);
        return json({ error: "save_failed", message: "Could not save this phone." }, 500);
      }
    }

    if (body?.language && body?.endpoint && !body?.subscription) {
      try {
        const updated = await updatePushSubscriptionLanguage(accountId, cleanString(body.endpoint, "", 600), body.language);
        return json({ ok: updated });
      } catch (error) {
        console.error("push_subscriptions:language_failed", error);
        return json({ error: "save_failed", message: "Could not update this browser." }, 500);
      }
    }

    const endpoint = cleanString(body?.subscription?.endpoint, "", 600);
    const p256dh = cleanString(body?.subscription?.keys?.p256dh, "", 300);
    const auth = cleanString(body?.subscription?.keys?.auth, "", 300);
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
        label: cleanString(body?.label, "", 200) || cleanString(req.headers.get("user-agent"), "", 200),
        language: body?.language,
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
    const nativeToken = cleanString(body?.nativeToken, "", 600);
    if (nativeToken) {
      try {
        return json({ ok: true, removed: await deleteNativePushDevice(accountId, nativeToken) });
      } catch (error) {
        console.error("push_subscriptions:native_delete_failed", error);
        return json({ error: "delete_failed", message: "Could not remove this phone." }, 500);
      }
    }
    const endpoint = cleanString(body?.endpoint, "", 600);
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
