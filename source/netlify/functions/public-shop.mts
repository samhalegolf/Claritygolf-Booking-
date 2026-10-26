import type { Config } from "@netlify/functions";

import { cancelOnlineOrder, confirmOnlineOrder, publicOnlineShop, startOnlineOrder } from "./billing-api.mts";
import { resolvePublicAccount } from "./_shared/coach-auth.mts";
import { json } from "./_shared/http.mts";
import { cleanString } from "./_shared/values.mts";

// The public shop page's four calls. Unauthenticated by design -- the buyer is
// a stranger -- so the business always comes from the page's own URL
// (?business=<slug>) and never from the body. Unlike the booking page there is
// no "the only business" fallback for a bare link: this route takes money, and
// which business it takes it for is not something to infer.
//
//   GET  /api/public-shop            what is for sale
//   POST /api/public-shop/checkout   start an order, get the Stripe page
//   POST /api/public-shop/order      the return page's poll: paid yet?
//   POST /api/public-shop/cancel     came back from Stripe without paying
//
// The work is in billing-api.mts (Online shop), next to the till it reuses.

async function readBody(req: Request) {
  try {
    const raw = await req.text();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/public-shop\/?/, "").replace(/\/$/, "");
  try {
    const business = cleanString(url.searchParams.get("business"), "", 120);
    const account = business ? await resolvePublicAccount(business) : null;
    if (!account) return json({ error: "unknown_business", message: "This shop was not found." }, 404);

    if (!action && req.method === "GET") return json(await publicOnlineShop(account.id));
    if (action === "checkout" && req.method === "POST") {
      return json(
        await startOnlineOrder(account.id, await readBody(req), {
          origin: url.origin,
          business: account.slug || business,
        }),
      );
    }
    if (action === "order" && req.method === "POST") {
      return json(await confirmOnlineOrder(account.id, (await readBody(req)).orderId));
    }
    if (action === "cancel" && req.method === "POST") {
      return json(await cancelOnlineOrder(account.id, (await readBody(req)).orderId));
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    console.error("public_shop:failed", action, error);
    const status = Number((error as { status?: unknown })?.status);
    const httpStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    // A stranger is told what to do about it, never what went wrong inside:
    // only errors raised on purpose (a 4xx) carry their message out.
    return json(
      {
        error: (error as { code?: string })?.code || "shop_error",
        message:
          httpStatus < 500 && error instanceof Error ? error.message : "Something went wrong. Please try again in a moment.",
      },
      httpStatus,
    );
  }
}

export const config: Config = {
  path: ["/api/public-shop", "/api/public-shop/checkout", "/api/public-shop/order", "/api/public-shop/cancel"],
};
