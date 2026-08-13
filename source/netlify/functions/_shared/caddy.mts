/**
 * The Booking side of the one deliberate Booking <-> Caddy seam.
 *
 * Booking administers the coaching relationship; Caddy administers the golf
 * product. This module is the only place Booking talks to Caddy, and it can do
 * exactly three things: make sure a coach-player relationship exists, issue a
 * pass, and read enough status to draw a card. It deliberately owns none of
 * Caddy's entitlement or billing logic -- Caddy stays the source of truth.
 *
 * The link between the two systems is the shared Supabase Auth user id, never
 * email. Email exists here only as a fallback for accounts that predate shared
 * auth and have not signed in since.
 *
 * Authentication is a shared secret set in both Netlify sites. It is
 * server-to-server only; it must never reach a browser.
 */

function env(name: string, fallback = ""): string {
  return (globalThis as any).Netlify?.env?.get(name) || process.env[name] || fallback;
}

export type CaddyPassType = "month_pass";

export type CaddyPlayerStatus = {
  /** Whether this person has a Clarity Caddy account at all. */
  connected: boolean;
  /** Whether this coach is one of the player's coaches in Caddy. */
  coachLinked: boolean;
  /** How many coaches the player has. Players are shared, not owned. */
  coachCount: number;
  /** "none" when there is no account, otherwise "free" or the active access label. */
  access: string;
  active: boolean;
  expiresAt: string | null;
  playerAccountId: string;
  /** Set when Caddy could not be reached; the card should say so rather than lie. */
  unavailable?: string;
};

export function caddyAppUrl() {
  return env("CLARITY_CADDY_URL", "https://caddy.claritygolf.app").replace(/\/+$/, "");
}

export function caddyConfigured() {
  return Boolean(env("CLARITY_SERVICE_SECRET") && env("CLARITY_CADDY_URL", "https://caddy.claritygolf.app"));
}

/**
 * The coach's identity in Caddy. Booking is single-coach per workspace today,
 * so this is configuration rather than a lookup. Either the Caddy account id or
 * the email that account was created with will resolve.
 */
function coachIdentity() {
  return {
    coachAccountId: env("CLARITY_CADDY_COACH_ACCOUNT_ID"),
    coachEmail: env("CLARITY_CADDY_COACH_EMAIL"),
  };
}

async function callCaddy(action: string, payload: Record<string, unknown>) {
  const secret = env("CLARITY_SERVICE_SECRET");
  if (!secret) {
    throw Object.assign(new Error("Clarity Caddy integration is not configured."), {
      status: 503,
      code: "caddy_not_configured",
    });
  }

  const response = await fetch(`${caddyAppUrl()}/api/clarity-integration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Clarity-Service-Secret": secret,
    },
    body: JSON.stringify({ action, ...coachIdentity(), ...payload }),
  });

  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok || body?.ok === false) {
    throw Object.assign(
      new Error(body?.message || body?.error || `Clarity Caddy request failed (${response.status})`),
      { status: response.status, code: body?.error || "caddy_request_failed" },
    );
  }
  return body || {};
}

/**
 * Idempotent. Adding a player from this coach never removes them from another
 * coach: in Caddy a player is an account that coaches have relationships with,
 * not a record a coach owns.
 */
export async function ensureCoachPlayerRelationship(playerAuthUserId: string, playerEmail: string) {
  return callCaddy("ensureRelationship", { playerAuthUserId, playerEmail });
}

export async function issueCaddyPass(args: {
  playerAuthUserId: string;
  playerEmail: string;
  passType?: CaddyPassType;
  issuedBy?: string;
}) {
  return callCaddy("issuePass", {
    playerAuthUserId: args.playerAuthUserId,
    playerEmail: args.playerEmail,
    passType: args.passType || "month_pass",
    issuedBy: args.issuedBy || "clarity_booking",
  });
}

/**
 * Never throws. The Caddy card is decoration on a Booking page -- if Caddy is
 * down or unconfigured the profile must still render, saying plainly that the
 * status could not be read.
 */
export async function readCaddyPlayerStatus(
  playerAuthUserId: string,
  playerEmail: string,
): Promise<CaddyPlayerStatus> {
  const empty: CaddyPlayerStatus = {
    connected: false,
    coachLinked: false,
    coachCount: 0,
    access: "none",
    active: false,
    expiresAt: null,
    playerAccountId: "",
  };
  if (!caddyConfigured()) return { ...empty, unavailable: "not_configured" };
  try {
    const body = await callCaddy("playerStatus", { playerAuthUserId, playerEmail });
    return {
      connected: Boolean(body.connected),
      coachLinked: Boolean(body.coachLinked),
      coachCount: Number(body.coachCount || 0),
      access: String(body.access || "none"),
      active: Boolean(body.active),
      expiresAt: body.expiresAt || null,
      playerAccountId: String(body.playerAccountId || ""),
    };
  } catch (error) {
    console.warn("caddy:player_status_failed", error instanceof Error ? error.message : error);
    return { ...empty, unavailable: "unreachable" };
  }
}

/**
 * Where "Open in Clarity Caddy" goes. The id in the URL is a pointer, not a
 * grant -- Caddy checks the signed-in coach and the relationship before showing
 * anything.
 */
export function caddyPlayerDeepLink(playerAuthUserId: string) {
  if (!playerAuthUserId) return "";
  return `${caddyAppUrl()}/?clarityPlayer=${encodeURIComponent(playerAuthUserId)}`;
}
