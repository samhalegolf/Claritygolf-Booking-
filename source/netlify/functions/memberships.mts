import type { Config } from "@netlify/functions";

import { requireCoachActor } from "./_shared/coach-auth.mts";
import { getDatabase } from "./_shared/database.mts";
import { currencyForAccountSettings } from "./_shared/locale.mts";
import {
  archivePlan,
  chargeAction,
  completeCardCheckout,
  createCardCheckout,
  enrolMembership,
  membershipAction,
  readMemberships,
  readPlans,
  savePlan,
  summariseMemberships,
  type MembershipAction,
} from "./_shared/memberships.mts";
import { stripeCredentialStatus, STRIPE_CONNECTION_SETTING } from "./_shared/stripe.mts";
import { json } from "./_shared/http.mts";

/**
 * Memberships -- the coach's side, plus the one public route a card form
 * returns to.
 *
 * The engine is _shared/memberships.mts; this file is routing, the account
 * (always from requireCoachActor, never the request), and the catalogue reads
 * the engine needs to validate a plan.
 *
 *   GET    /api/memberships                 plans, members, summary
 *   GET    /api/memberships?personId=       one client's memberships
 *   POST   /api/memberships/plans           create or update a plan
 *   DELETE /api/memberships/plans?id=       retire a plan
 *   POST   /api/memberships/enrol           put a client on a plan
 *   POST   /api/memberships/action          cancel, pause, resume, retry...
 *   POST   /api/memberships/charge          mark a period paid, waive, void
 *   POST   /api/memberships/card-link       a card form to send the member
 *   GET    /api/memberships/checkout/return where Stripe sends the member back
 */

const ACTIONS: MembershipAction[] = [
  "cancel_at_period_end",
  "undo_cancel",
  "end_now",
  "pause",
  "resume",
  "retry",
  "use_manual",
];

async function body(req: Request): Promise<Record<string, any>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function settings(accountId: string, keys: string[]) {
  const rows = (await getDatabase().sql`
    SELECT key, value FROM settings WHERE account_id = ${accountId} AND key = ANY(${keys})
  `) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value])) as Record<string, string>;
}

function parse(value: string | undefined) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

/** Currency, catalogue ids and whether cards can be saved, in one read. */
async function accountContext(accountId: string) {
  const map = await settings(accountId, [
    "servicesJson",
    "accountInvoiceSettingsJson",
    "accountCountry",
    STRIPE_CONNECTION_SETTING,
  ]);
  const services = parse(map.servicesJson);
  return {
    currency: currencyForAccountSettings(parse(map.accountInvoiceSettingsJson)?.currency, map.accountCountry),
    // Unvalidated when the catalogue cannot be read, rather than refusing every
    // plan: the editor only offers ids it was given, and the job only spends
    // credits on what a booking names.
    serviceIds: Array.isArray(services)
      ? new Set<string>(services.map((service: { id?: unknown }) => String(service?.id || "")).filter(Boolean))
      : undefined,
    cardsReady: stripeCredentialStatus(map[STRIPE_CONNECTION_SETTING]).features.portal,
  };
}

function htmlPage(title: string, message: string, status = 200) {
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] || char);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escape(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f5;color:#1d2420;` +
      `display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:420px;background:#fff;` +
      `border-radius:14px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)}h1{font-size:1.3rem;margin:0 0 8px}` +
      `@media (prefers-color-scheme:dark){body{background:#141816;color:#e8ece9}main{background:#1e2420}}</style></head>` +
      `<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/**
 * Stripe sends the member here after the card form. Public on purpose -- the
 * member may not be signed in, if a coach sent them the link -- and safe
 * because nothing is taken from the URL but a session id, which is then read
 * back from Stripe on the business's own account. Whose membership it is
 * comes from that session's metadata.
 */
async function checkoutReturn(url: URL) {
  const accountId = (url.searchParams.get("account") || "").slice(0, 120);
  const to = url.searchParams.get("to") === "portal" ? "portal" : "link";
  const sessionId = (url.searchParams.get("session_id") || "").slice(0, 200);
  if (url.searchParams.get("cancelled")) {
    return htmlPage("No card saved", "Nothing was charged. You can close this page and use the link again when you are ready.");
  }
  let outcome: "saved" | "pending" | "not_found" | "error" = "error";
  if (accountId && sessionId.startsWith("cs_")) {
    try {
      outcome = (await completeCardCheckout(accountId, sessionId)).status;
    } catch (error) {
      console.error("memberships:checkout_return_failed", accountId, error instanceof Error ? error.message : error);
    }
  }
  if (to === "portal") {
    const target = outcome === "saved" ? "joined" : outcome === "pending" ? "pending" : "error";
    return Response.redirect(`${url.origin}/?membership=${target}`, 303);
  }
  if (outcome === "saved") return htmlPage("You're all set", "Your card is saved and your membership is active. You can close this page.");
  if (outcome === "pending") return htmlPage("Almost there", "Your bank is still confirming the payment. Your membership starts as soon as it does.");
  return htmlPage("Something went wrong", "We could not confirm that card. Nothing extra was charged — please contact your coach.", 400);
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/\.netlify\/functions\/memberships/, "/api/memberships").replace(/\/$/, "");

  try {
    if (req.method === "GET" && path === "/api/memberships/checkout/return") return await checkoutReturn(url);

    const actor = await requireCoachActor(req);
    const accountId = actor.accountId;
    const who = { accountId, actorId: actor.authUserId };

    if (req.method === "GET" && path === "/api/memberships") {
      const personId = (url.searchParams.get("personId") || "").slice(0, 160);
      const context = await accountContext(accountId);
      const [plans, memberships] = await Promise.all([
        readPlans(accountId),
        readMemberships(accountId, personId ? { personId } : {}),
      ]);
      return json({
        plans,
        memberships,
        summary: personId ? null : summariseMemberships(memberships),
        cardsReady: context.cardsReady,
        currency: context.currency,
      });
    }

    if (req.method === "POST" && path === "/api/memberships/plans") {
      const input = await body(req);
      const context = await accountContext(accountId);
      return json({ plans: await savePlan(input.plan || input, context, who) });
    }

    if (req.method === "DELETE" && path === "/api/memberships/plans") {
      return json({ plans: await archivePlan(url.searchParams.get("id") || "", who) });
    }

    if (req.method === "POST" && path === "/api/memberships/enrol") {
      const input = await body(req);
      const membership = await enrolMembership(input, who);
      const checkoutUrl =
        membership.status === "incomplete"
          ? await createCardCheckout(accountId, membership.id, url.origin, "link")
          : "";
      return json({ membership, checkoutUrl }, 201);
    }

    if (req.method === "POST" && path === "/api/memberships/action") {
      const input = await body(req);
      const action = String(input.action || "") as MembershipAction;
      if (!ACTIONS.includes(action)) return json({ error: "invalid", message: "Unknown action." }, 400);
      return json({
        membership: await membershipAction(String(input.membershipId || ""), action, who, {
          reason: typeof input.reason === "string" ? input.reason : "",
        }),
      });
    }

    if (req.method === "POST" && path === "/api/memberships/charge") {
      const input = await body(req);
      const action = input.action === "waive" ? "waive" : input.action === "void" ? "void" : "mark_paid";
      return json({
        membership: await chargeAction(String(input.chargeId || ""), action, who, {
          via: typeof input.via === "string" ? input.via : "",
          note: typeof input.note === "string" ? input.note : "",
        }),
      });
    }

    if (req.method === "POST" && path === "/api/memberships/card-link") {
      const input = await body(req);
      return json({ url: await createCardCheckout(accountId, String(input.membershipId || ""), url.origin, "link") });
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 500;
    if (status >= 500) console.error("memberships:failed", path, error);
    return json({
        error: (error as { code?: string })?.code || "failed",
        message: status >= 500 && status !== 502 && status !== 503 ? "Something went wrong." : (error as Error).message,
      }, status);
  }
}

export const config: Config = {
  path: [
    "/api/memberships",
    "/api/memberships/plans",
    "/api/memberships/enrol",
    "/api/memberships/action",
    "/api/memberships/charge",
    "/api/memberships/card-link",
    "/api/memberships/checkout/return",
  ],
};
