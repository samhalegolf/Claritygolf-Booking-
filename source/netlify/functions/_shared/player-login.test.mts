/**
 * Signing in as a portal player.
 *
 * Coach and player share one Supabase Auth store, and `verifyCoachAuthPassword`
 * is a straight alias of `verifySupabaseAuthPassword` -- so the "coach first,
 * player second" order in /api/auth/login does NOT separate the two. Every
 * player with a correct password passes the coach check, and the membership
 * lookup that follows finds nothing, because a player has no
 * account_memberships row and is not supposed to have one.
 *
 * That combination used to answer 403 "This login is not attached to a business
 * workspace yet" and return, leaving the player branch further down unreachable
 * for anyone whose password was right. A player could set a password through
 * the reset flow and still not get in.
 *
 * These drive the real route with the auth server stubbed, so the assertions
 * are about what a player actually receives.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "./database.mts";
import { handleBookingApiRoute } from "../booking-core.mts";

const ACCOUNT = "sam-hale-golf";
const PLAYER_AUTH_USER = "5cdec1ad-9bb6-49fb-bce0-b68ea51b6d2c";
const PLAYER_EMAIL = "player@example.test";
const COACH_AUTH_USER = "d9f5da19-c79d-4008-bb46-5b747e8c28bb";
const COACH_EMAIL = "coach@example.test";

type Fixture = {
  /** auth user id the password grant returns, or "" to reject the password. */
  authUserId: string;
  /** portal_players rows visible to the lookup. */
  portalPlayers: Record<string, unknown>[];
  /** account_memberships rows visible to the lookup. */
  memberships: Record<string, unknown>[];
};

function installDatabase(fixture: Fixture) {
  const answer = (raw: string): unknown[] => {
    const text = raw.replace(/\s+/g, " ").trim();
    // resolvePublicAccountId: exactly one active account means no ?business= is
    // needed, which is the shape of this deployment.
    if (/FROM accounts/i.test(text)) return [{ id: ACCOUNT, status: "active" }];
    if (/FROM account_memberships/i.test(text)) return fixture.memberships;
    if (/FROM portal_players/i.test(text)) return fixture.portalPlayers;
    if (/FROM people/i.test(text)) {
      return [{ id: "person-1", name: "Jordan Fisher", email: PLAYER_EMAIL, phone: "" }];
    }
    if (/FROM admin_users/i.test(text)) return [];
    // Writes (the portal_players touch, the player_sessions insert) and DDL.
    return [];
  };

  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = "";
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) text += `$${index + 1}`;
      });
      return answer(text);
    },
    pool: {
      async query(text: string) {
        return { rows: answer(text) };
      },
      async connect() {
        return {
          async query(text: string) {
            return { rows: answer(text) };
          },
          release() {},
        };
      },
    },
  });
}

/**
 * Stands in for GoTrue. The password grant is the only call the login path
 * makes that leaves the process, and the route's whole bug was about what it
 * concluded from a SUCCESSFUL one.
 */
function installAuthServer(authUserId: string) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/auth/v1/token")) {
      return authUserId
        ? new Response(JSON.stringify({ access_token: "tok", user: { id: authUserId } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    if (url.includes("/auth/v1/logout")) return new Response("", { status: 204 });
    throw new Error(`unexpected outbound call in test: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function activePortalPlayer() {
  return {
    id: "portal-1",
    account_id: ACCOUNT,
    person_id: "person-1",
    auth_user_id: PLAYER_AUTH_USER,
    email: PLAYER_EMAIL,
    status: "active",
    invited_at: null,
    activated_at: null,
    last_login_at: null,
  };
}

function ownerMembership() {
  return { id: "m-1", account_id: ACCOUNT, auth_user_id: COACH_AUTH_USER, role: "owner", active: true };
}

async function login(email: string, password = "correct-horse-battery") {
  const request = new Request("https://book.example.test/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const response = await handleBookingApiRoute(request, "/api/auth/login", {} as never);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function withFixture(fixture: Fixture, run: () => Promise<void>) {
  process.env.SUPABASE_URL ||= "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-key";
  process.env.SUPABASE_ANON_KEY ||= "anon-key";
  process.env.DATABASE_URL ||= "postgres://stub/stub";
  installDatabase(fixture);
  const restoreFetch = installAuthServer(fixture.authUserId);
  try {
    await run();
  } finally {
    restoreFetch();
    setDatabaseForTests(null);
  }
}

test("a portal player with the right password gets a player session, not a workspace refusal", async () => {
  await withFixture(
    { authUserId: PLAYER_AUTH_USER, portalPlayers: [activePortalPlayer()], memberships: [] },
    async () => {
      const { status, body } = await login(PLAYER_EMAIL);

      assert.equal(
        body.error,
        undefined,
        `a player was refused: ${JSON.stringify(body)}`,
      );
      assert.notEqual(
        body.error,
        "membership_required",
        "a player has no account_memberships row by design and must not be asked for one",
      );
      assert.equal(status, 200);
      assert.equal(body.authenticated, true);
      assert.equal(body.role, "player");
    },
  );
});

test("a coach with a workspace still signs in as a coach", async () => {
  await withFixture(
    { authUserId: COACH_AUTH_USER, portalPlayers: [], memberships: [ownerMembership()] },
    async () => {
      const { status, body } = await login(COACH_EMAIL);

      assert.equal(status, 200);
      assert.equal(body.authenticated, true);
      assert.notEqual(body.role, "player", "the membership path must still win for a coach");
    },
  );
});

test("a verified identity that is neither coach nor player is still refused", async () => {
  // The 403 has a real job -- it just must not be the answer for a player.
  await withFixture(
    { authUserId: "stranger-auth-user", portalPlayers: [], memberships: [] },
    async () => {
      const { status, body } = await login("stranger@example.test");

      assert.equal(status, 403);
      assert.equal(body.error, "membership_required");
    },
  );
});

test("revoked portal access does not become a login", async () => {
  await withFixture(
    {
      authUserId: PLAYER_AUTH_USER,
      portalPlayers: [{ ...activePortalPlayer(), status: "disabled" }],
      memberships: [],
    },
    async () => {
      const { status, body } = await login(PLAYER_EMAIL);

      assert.equal(status, 403);
      assert.equal(body.error, "membership_required");
      assert.notEqual(body.role, "player", "a disabled row is not access");
    },
  );
});

test("a wrong password is still a wrong password", async () => {
  await withFixture(
    { authUserId: "", portalPlayers: [activePortalPlayer()], memberships: [] },
    async () => {
      const { status, body } = await login(PLAYER_EMAIL, "not-the-password");

      assert.equal(status, 401);
      assert.equal(body.error, "invalid_login");
    },
  );
});
