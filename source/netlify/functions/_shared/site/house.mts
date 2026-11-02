// Clarity's own websites ("house" sites), and who may edit them.
//
// Each of Clarity's public sites is an account of kind 'house' with a site
// like any business's, built and served by the same website builder. Nobody
// holds a membership on a house account. It is edited from Clarity Studio
// (the Caddy deploy) by a Studio admin, who reaches this deploy with a Studio
// pass: a short-lived token Caddy signs once it has checked the admin's own
// login, with the service secret the two deploys already share
// (CLARITY_SERVICE_SECRET). Booking never sees the admin's Caddy login, and
// Caddy never sees Booking's database.
//
// The pass, as Caddy writes it (functions/studio-site-pass.mjs):
//
//   v1.<payload>.<signature>
//   payload    base64url of {"aud":"clarity-studio-sites","sub":<admin email>,"exp":<unix seconds>}
//   signature  base64url of HMAC-SHA256(secret, "v1.<payload>")
//
// The two sides share no code (they are different repositories), so both
// test the same fixed vector: see STUDIO_PASS_TEST_VECTOR in house.test.mts
// and dev/studio-site-pass.test.js in Caddy.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getDatabase } from "../database.mts";
import { cleanSlug, env } from "../values.mts";

export const HOUSE_KIND = "house";
export const STUDIO_PASS_AUDIENCE = "clarity-studio-sites";
export const STUDIO_PASS_HEADER = "x-clarity-studio-pass";

/** What a house site is for, by account id. Picks the starting template and the note Studio shows. */
export const HOUSE_SITE_ROLES: Record<string, { template: string; note: string }> = {
  "clarity-caddy": {
    template: "house-caddy",
    note: "The Clarity Caddy website. Point its domain here under \"Where the page lives\" once it is published.",
  },
  "clarity-booking": {
    template: "house-booking",
    note: "Shown at the root of claritygolf.app: Home at /, and the Privacy, Terms and Support pages at /privacy, /terms and /support. Any other page lives at claritygolf.app/clarity-booking/site/<page>.",
  },
};

export type HouseAccount = { id: string; slug: string; name: string };

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signature(secret: string, signed: string): string {
  return base64url(createHmac("sha256", secret).update(signed).digest());
}

/**
 * The admin a Studio pass was issued to, or null when it is missing, forged,
 * expired or meant for something else. `now` is unix seconds.
 */
export function verifyStudioPass(pass: string, secret: string, now = Math.floor(Date.now() / 1000)): { email: string } | null {
  if (!pass || !secret) return null;
  const parts = pass.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expected = Buffer.from(signature(secret, `v1.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload: { aud?: unknown; sub?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.aud !== STUDIO_PASS_AUDIENCE) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  const email = typeof payload.sub === "string" ? payload.sub.trim().toLowerCase() : "";
  return email ? { email } : null;
}

/** The Studio admin making this request. 401 without a good pass. */
export function requireStudioAdmin(req: Request): { email: string } {
  const secret = env("CLARITY_SERVICE_SECRET");
  if (!secret) fail(403, "studio_not_configured", "Studio editing is not switched on: CLARITY_SERVICE_SECRET is not set on Clarity Booking.");
  const admin = verifyStudioPass(req.headers.get(STUDIO_PASS_HEADER) || "", secret);
  if (!admin) fail(401, "studio_pass_required", "Open this from Clarity Studio, signed in as an admin.");
  return admin;
}

/** Every house site, in a fixed order. */
export async function listHouseAccounts(): Promise<HouseAccount[]> {
  const rows = (await getDatabase().sql`
    SELECT id, slug, business_name FROM accounts
    WHERE kind = ${HOUSE_KIND} AND status = 'active'
    ORDER BY business_name ASC, id ASC
  `) as Array<{ id: string; slug: string; business_name: string }>;
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.business_name }));
}

/** One house site by id or slug, or null. Never a business: kind is checked here, not trusted from the caller. */
export async function readHouseAccount(idOrSlug: string): Promise<HouseAccount | null> {
  const clean = cleanSlug(idOrSlug, "");
  if (!clean) return null;
  const rows = (await getDatabase().sql`
    SELECT id, slug, business_name FROM accounts
    WHERE (id = ${clean} OR slug = ${clean}) AND kind = ${HOUSE_KIND} AND status = 'active'
    LIMIT 1
  `) as Array<{ id: string; slug: string; business_name: string }>;
  const row = rows[0];
  return row ? { id: row.id, slug: row.slug, name: row.business_name } : null;
}
