/**
 * Clarity Pay: a Stripe account Clarity creates for the business.
 *
 * The business never needs a Stripe account of its own. Clarity creates one on
 * its platform, Stripe runs the signup (identity and bank details) on a page
 * Stripe hosts, and once Stripe says the account can take charges it becomes
 * the business's card connection with route "clarity_pay".
 *
 * The account is Standard-like: Stripe charges the business its card fees
 * directly and carries the fraud and chargeback risk, and the business gets a
 * full Stripe dashboard for payouts. Clarity's cut is the application fee on
 * each charge (see clarityPayFeeCents).
 *
 * The created account is remembered apart from the live connection, so a
 * business that turns Clarity Pay off and on again gets the same account back
 * instead of doing Stripe's signup twice. It is only switched on while the
 * business has asked for it (`wanted`), so turning it off stays off.
 */

import { getDatabase } from "./database.mts";
import {
  parseStripeConnection,
  stripePlatform,
  stripeRequest,
  STRIPE_CONNECTION_SETTING,
  type StripeConnection,
} from "./stripe.mts";

/** The Clarity Pay account made for this business, live or not. */
export const CLARITY_PAY_ACCOUNT_SETTING = "clarityPayAccount";

/** Where Clarity Pay stands for a business. */
export type ClarityPaySetup = "none" | "pending" | "active";

function db() {
  return getDatabase();
}

async function readSetting(accountId: string, key: string) {
  const rows = (await db().sql`
    SELECT value FROM settings WHERE account_id = ${accountId} AND key = ${key} LIMIT 1
  `) as Array<{ value: string }>;
  return String(rows[0]?.value || "");
}

async function saveSetting(accountId: string, key: string, value: string) {
  await db().sql`
    INSERT INTO settings (account_id, key, value, updated_at)
    VALUES (${accountId}, ${key}, ${value}, NOW())
    ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

function platformCredential(livemode: boolean) {
  const { secret } = stripePlatform(livemode);
  if (!secret) {
    throw Object.assign(new Error("Clarity Pay is unavailable right now. Clarity's Stripe platform is not set up."), {
      status: 503,
    });
  }
  // No account: these requests act on Clarity's own platform account.
  return { secret, account: "" };
}

type SavedClarityPay = { account: string; livemode: boolean; wanted: boolean };

async function readSaved(accountId: string, livemode: boolean): Promise<SavedClarityPay | null> {
  const value = await readSetting(accountId, CLARITY_PAY_ACCOUNT_SETTING);
  const saved = parseStripeConnection(value);
  if (!saved || saved.livemode !== livemode) return null;
  let wanted = false;
  try {
    wanted = JSON.parse(value)?.wanted === true;
  } catch {
    // parseStripeConnection already accepted it; an unreadable flag is "no".
  }
  return { account: saved.account, livemode, wanted };
}

async function writeSaved(accountId: string, saved: SavedClarityPay) {
  await saveSetting(accountId, CLARITY_PAY_ACCOUNT_SETTING, JSON.stringify(saved));
}

/** The Clarity Pay account made for this business in this mode, if any. */
export async function readClarityPayAccount(accountId: string, livemode: boolean): Promise<string> {
  return (await readSaved(accountId, livemode))?.account || "";
}

/**
 * The business's Clarity Pay account, created on first use, and marked as
 * wanted so it switches on as soon as Stripe allows.
 *
 * Country and email are prefilled so Stripe's signup asks less. Country cannot
 * be changed once the account exists, so it is only sent when it is a real
 * two-letter code; otherwise Stripe asks.
 */
export async function ensureClarityPayAccount(
  accountId: string,
  livemode: boolean,
  prefill: { country?: string; email?: string },
): Promise<string> {
  const existing = await readSaved(accountId, livemode);
  if (existing) {
    if (!existing.wanted) await writeSaved(accountId, { ...existing, wanted: true });
    return existing.account;
  }

  const params = new URLSearchParams();
  // Stripe collects fees from the business, carries the losses, and gives
  // them a full dashboard: the business owns its Stripe relationship.
  params.set("controller[fees][payer]", "account");
  params.set("controller[losses][payments]", "stripe");
  params.set("controller[requirement_collection]", "stripe");
  params.set("controller[stripe_dashboard][type]", "full");
  params.set("capabilities[card_payments][requested]", "true");
  params.set("capabilities[transfers][requested]", "true");
  params.set("metadata[clarity_account_id]", accountId);
  const country = String(prefill.country || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) params.set("country", country);
  if (prefill.email && prefill.email.includes("@")) params.set("email", prefill.email);

  const created = await stripeRequest(platformCredential(livemode), "accounts", { method: "POST", params });
  const account = String(created?.id || "");
  if (!/^acct_[A-Za-z0-9]+$/.test(account)) {
    throw Object.assign(new Error("Stripe did not create the Clarity Pay account."), { status: 502 });
  }
  await writeSaved(accountId, { account, livemode, wanted: true });
  return account;
}

/**
 * A one-time link to Stripe's signup for this account.
 *
 * Links expire within minutes and can only be opened once, so one is made
 * each time the business clicks, never stored or emailed.
 */
export async function clarityPaySignupLink(account: string, livemode: boolean, origin: string) {
  const params = new URLSearchParams();
  params.set("account", account);
  params.set("type", "account_onboarding");
  params.set("refresh_url", `${origin}/api/stripe-connect/clarity-pay/refresh`);
  params.set("return_url", `${origin}/api/stripe-connect/clarity-pay/return`);
  const link = await stripeRequest(platformCredential(livemode), "account_links", { method: "POST", params });
  if (!link?.url) throw Object.assign(new Error("Stripe did not return a signup link."), { status: 502 });
  return String(link.url);
}

/** Best effort: stop Clarity acting on a business's own Stripe account. */
export async function deauthorizeOwnStripe(connection: StripeConnection) {
  if (connection.route !== "own_stripe") return;
  const platform = stripePlatform(connection.livemode);
  if (!platform.clientId || !platform.secret) return;
  // If the business already revoked Clarity from its Stripe dashboard this
  // fails, and forgetting the connection is still right.
  await fetch("https://connect.stripe.com/oauth/deauthorize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${platform.secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: platform.clientId, stripe_user_id: connection.account }).toString(),
  }).catch(() => null);
}

/**
 * Where Clarity Pay stands, switching it on the moment Stripe allows charges.
 *
 * Called when the business comes back from Stripe's signup, when the settings
 * screen asks, and from the account.updated webhook. Whichever sees the
 * account ready first switches it on; the rest find it already active. A
 * business moving over from its own Stripe keeps taking invoice payments there
 * until this moment.
 */
export async function syncClarityPay(accountId: string, livemode: boolean): Promise<ClarityPaySetup> {
  const current = parseStripeConnection(await readSetting(accountId, STRIPE_CONNECTION_SETTING));
  if (current?.route === "clarity_pay") return "active";

  const saved = await readSaved(accountId, livemode);
  if (!saved?.wanted) return "none";
  const { account } = saved;

  const details = await stripeRequest(platformCredential(livemode), `accounts/${encodeURIComponent(account)}`);
  if (details?.charges_enabled !== true) return "pending";

  await writeSaved(accountId, { ...saved, wanted: false });
  await saveSetting(
    accountId,
    STRIPE_CONNECTION_SETTING,
    JSON.stringify({ account, livemode, route: "clarity_pay" }),
  );
  if (current) await deauthorizeOwnStripe(current);
  return "active";
}

/** The businesses a Clarity Pay account was made for, for webhook routing. */
export async function accountsForClarityPayAccount(stripeAccount: string, livemode: boolean): Promise<string[]> {
  if (!/^acct_[A-Za-z0-9]+$/.test(stripeAccount)) return [];
  const rows = (await db()
    .sql`
      SELECT account_id, value FROM settings
      WHERE key = ${CLARITY_PAY_ACCOUNT_SETTING}
        AND value LIKE ${`%"${stripeAccount}"%`}
    `
    .catch(() => [])) as Array<{ account_id: string; value: string }>;
  return rows
    .filter((row) => {
      const saved = parseStripeConnection(row.value);
      return saved?.account === stripeAccount && saved.livemode === livemode;
    })
    .map((row) => row.account_id);
}
