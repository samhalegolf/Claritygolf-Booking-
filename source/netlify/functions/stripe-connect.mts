import type { Config } from "@netlify/functions";
import { randomBytes } from "node:crypto";

import {
  clarityPaySignupLink,
  deauthorizeOwnStripe,
  ensureClarityPayAccount,
  readClarityPayAccount,
  syncClarityPay,
} from "./_shared/clarity-pay.mts";
import { requireCoachActor } from "./_shared/coach-auth.mts";
import { getDatabase } from "./_shared/database.mts";
import { readSandboxAccount } from "./_shared/sandbox.mts";
import {
  parseStripeConnection,
  stripeCredentialStatus,
  stripePlatform,
  STRIPE_CONNECTION_SETTING,
} from "./_shared/stripe.mts";

/**
 * How a business sets up card payments. Two routes (see _shared/stripe.mts):
 *
 *   GET  /api/stripe-connect/status             where things stand
 *
 * Clarity Pay, an account Clarity creates (see _shared/clarity-pay.mts):
 *
 *   POST /api/stripe-connect/clarity-pay/start  { url } of Stripe's signup
 *   GET  /api/stripe-connect/clarity-pay/return where Stripe's signup ends
 *   GET  /api/stripe-connect/clarity-pay/refresh a fresh signup link, when
 *                                               the last one expired
 *
 * Own Stripe, a Stripe sign-in to an existing account (Connect OAuth):
 *
 *   POST /api/stripe-connect/connect            { authUrl } to send the browser to
 *   GET  /api/stripe-connect/callback           where Stripe sends it back
 *
 *   POST /api/stripe-connect/disconnect         stop taking cards either way
 *
 * All Clarity keeps is the connected account id, its mode and its route.
 * Payments are then made with the platform key on that account.
 *
 * A sandbox connects in test mode and everything else in live mode, decided
 * here from the business rather than chosen by whoever is clicking.
 *
 * Stripe needs `<origin>/api/stripe-connect/callback` listed as a redirect URI
 * in the platform's Connect settings, in both modes.
 */

/** Where a sign-in in flight is remembered until Stripe sends the browser back. */
const STATE_SETTING = "stripeConnectOAuthState";
/** Long enough to sign up to Stripe from scratch mid-flow; short enough to expire. */
const STATE_TTL_MS = 60 * 60 * 1000;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function db() {
  return getDatabase();
}

async function saveSetting(accountId: string, key: string, value: string) {
  await db().sql`
    INSERT INTO settings (account_id, key, value, updated_at)
    VALUES (${accountId}, ${key}, ${value}, NOW())
    ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

async function deleteSetting(accountId: string, key: string) {
  await db().sql`DELETE FROM settings WHERE account_id = ${accountId} AND key = ${key}`;
}

async function readSetting(accountId: string, key: string) {
  const rows = (await db().sql`
    SELECT value FROM settings WHERE account_id = ${accountId} AND key = ${key} LIMIT 1
  `) as Array<{ value: string }>;
  return String(rows[0]?.value || "");
}

function forbidden() {
  return Object.assign(new Error("Only an owner or admin can change where payments go."), { status: 403 });
}

function notReady() {
  return Object.assign(new Error("Stripe sign-in is not available yet. Clarity's Stripe platform is not set up."), {
    status: 503,
  });
}

async function businessLivemode(accountId: string) {
  return !(await readSandboxAccount(accountId));
}

async function status(req: Request) {
  const actor = await requireCoachActor(req);
  // A Stripe hiccup must not blank the settings card; it just reads as
  // "still setting up" until the next look.
  const clarityPay = await syncClarityPay(actor.accountId, await businessLivemode(actor.accountId)).catch(
    () => "pending" as const,
  );
  return {
    stripe: stripeCredentialStatus(await readSetting(actor.accountId, STRIPE_CONNECTION_SETTING)),
    clarityPay,
  };
}

async function actorEmail(authUserId: string) {
  const rows = (await db()
    .sql`SELECT email FROM auth.users WHERE id = ${authUserId} LIMIT 1`
    .catch(() => [])) as Array<{ email: string }>;
  return String(rows[0]?.email || "");
}

/**
 * Stripe's signup for this business's Clarity Pay account, made on first use.
 *
 * Empty when there is nothing left to sign up for: an account Stripe already
 * approved, turned back on, is switched on here and needs no trip to Stripe.
 */
async function clarityPaySignupUrl(req: Request) {
  const actor = await requireCoachActor(req);
  if (!actor.isAdmin) throw forbidden();
  const livemode = await businessLivemode(actor.accountId);
  const account = await ensureClarityPayAccount(actor.accountId, livemode, {
    country: await readSetting(actor.accountId, "accountCountry"),
    email: await actorEmail(actor.authUserId),
  });
  if ((await syncClarityPay(actor.accountId, livemode)) === "active") return "";
  return clarityPaySignupLink(account, livemode, new URL(req.url).origin);
}

/** Back from Stripe's signup: switch Clarity Pay on if Stripe is happy. */
async function finishClarityPay(req: Request): Promise<{ title: string; message: string }> {
  const actor = await requireCoachActor(req);
  const livemode = await businessLivemode(actor.accountId);
  if (!(await readClarityPayAccount(actor.accountId, livemode))) {
    return { title: "Clarity Pay not set up", message: "Start again from Settings." };
  }
  const setup = await syncClarityPay(actor.accountId, livemode);
  return setup === "active"
    ? { title: "Clarity Pay is on", message: "Card payments now go straight to your account, and Stripe pays them out to your bank." }
    : {
        title: "Almost there",
        message:
          "Stripe is still checking your details, or needs a few more. Clarity Pay switches on by itself once Stripe is done; you can finish any remaining steps from Settings.",
      };
}

async function startConnect(req: Request) {
  const actor = await requireCoachActor(req);
  if (!actor.isAdmin) throw forbidden();
  const current = parseStripeConnection(await readSetting(actor.accountId, STRIPE_CONNECTION_SETTING));
  if (current?.route === "clarity_pay") {
    throw Object.assign(new Error("Clarity Pay is on. Turn it off before connecting your own Stripe."), { status: 409 });
  }
  const livemode = await businessLivemode(actor.accountId);
  const platform = stripePlatform(livemode);
  if (!platform.clientId || !platform.secret) throw notReady();

  const state = randomBytes(24).toString("hex");
  await saveSetting(actor.accountId, STATE_SETTING, JSON.stringify({ state, livemode, startedAt: Date.now() }));

  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", platform.clientId);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${new URL(req.url).origin}/api/stripe-connect/callback`);
  return { authUrl: url.toString() };
}

/** The business that started this sign-in, found by its one-time state. */
async function pendingSignIn(state: string) {
  if (!/^[a-f0-9]{48}$/.test(state)) return null;
  const rows = (await db().sql`
    SELECT account_id, value FROM settings
    WHERE key = ${STATE_SETTING} AND value LIKE ${`%"${state}"%`}
    LIMIT 1
  `) as Array<{ account_id: string; value: string }>;
  const row = rows[0];
  if (!row) return null;
  let saved: { state?: string; livemode?: boolean; startedAt?: number } = {};
  try {
    saved = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (saved.state !== state || Date.now() - Number(saved.startedAt || 0) > STATE_TTL_MS) return null;
  return { accountId: row.account_id, livemode: saved.livemode === true };
}

async function finishConnect(req: Request): Promise<string> {
  const url = new URL(req.url);
  const pending = await pendingSignIn(url.searchParams.get("state") || "");
  if (!pending) return "That sign-in link has expired. Start again from Settings.";
  // One use only, whatever happens next.
  await deleteSetting(pending.accountId, STATE_SETTING);

  if (url.searchParams.get("error")) {
    return url.searchParams.get("error_description") || "Stripe did not connect.";
  }
  const code = url.searchParams.get("code") || "";
  const platform = stripePlatform(pending.livemode);
  if (!code || !platform.secret) return "Stripe did not connect.";

  const response = await fetch("https://connect.stripe.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${platform.secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const connection = parseStripeConnection({
    account: data.stripe_user_id,
    livemode: pending.livemode,
    route: "own_stripe",
  });
  if (!response.ok || !connection) {
    return String(data.error_description || "Stripe did not connect.");
  }
  await saveSetting(pending.accountId, STRIPE_CONNECTION_SETTING, JSON.stringify(connection));
  return "";
}

async function disconnect(req: Request) {
  const actor = await requireCoachActor(req);
  if (!actor.isAdmin) throw forbidden();
  const connection = parseStripeConnection(await readSetting(actor.accountId, STRIPE_CONNECTION_SETTING));
  // A Clarity Pay account stays remembered, so turning it back on reuses it.
  if (connection) await deauthorizeOwnStripe(connection);
  await deleteSetting(actor.accountId, STRIPE_CONNECTION_SETTING);
  return { ok: true };
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] || char);
}

function callbackPage(error: string) {
  return resultPage(
    error ? "Stripe not connected" : "Stripe connected",
    error || "Invoice payments now go straight to your own Stripe account.",
  );
}

function resultPage(title: string, message: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, system-ui, sans-serif; background: #f5f5f3; color: #171717; }
      main { width: min(440px, calc(100vw - 32px)); padding: 24px; border: 1px solid #deded8; border-radius: 12px; background: #fff; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p { margin: 0 0 18px; color: #5d5a54; line-height: 1.45; }
      a { display: inline-flex; min-height: 42px; align-items: center; padding: 0 16px; border-radius: 8px; background: #111; color: #fff; text-decoration: none; font-weight: 800; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="/?view=settings">Back to Clarity Booking</a>
    </main>
  </body>
</html>`;
}

export default async function handler(req: Request) {
  const action = new URL(req.url).pathname
    .replace(/^\/api\/stripe-connect\/?/, "")
    .replace(/^\/\.netlify\/functions\/stripe-connect\/?/, "");
  const html = (page: string) =>
    new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  try {
    if (req.method === "GET" && action === "callback") return html(callbackPage(await finishConnect(req)));
    if (req.method === "GET" && action === "status") return json(await status(req));
    if (req.method === "POST" && action === "clarity-pay/start") return json({ url: await clarityPaySignupUrl(req) });
    if (req.method === "GET" && (action === "clarity-pay/return" || action === "clarity-pay/refresh")) {
      // Stripe sends the browser here, so a failure is a page, not JSON.
      try {
        if (action === "clarity-pay/refresh") {
          const location = (await clarityPaySignupUrl(req)) || "/?view=settings";
          return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
        }
        const result = await finishClarityPay(req);
        return html(resultPage(result.title, result.message));
      } catch (error) {
        return html(resultPage("Clarity Pay not set up", error instanceof Error ? error.message : "Start again from Settings."));
      }
    }
    if (req.method === "POST" && action === "connect") return json(await startConnect(req));
    if (req.method === "POST" && action === "disconnect") return json(await disconnect(req));
    return json({ error: "not_found" }, 404);
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 500;
    return json({ error: "stripe_connect_failed", message: error instanceof Error ? error.message : "Stripe connection failed." }, status);
  }
}

export const config: Config = {
  path: "/api/stripe-connect/*",
};
