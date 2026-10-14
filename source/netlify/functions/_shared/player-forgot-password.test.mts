/**
 * "Forgot password" for a portal player when two businesses are live.
 *
 * The Clarity Player app posts to /api/auth/forgot-password with no ?business=.
 * With one live business resolvePublicAccountId could guess it; from 2 Oct
 * there were two (sam-hale-golf and clarity-demo-golf), the guess came back
 * empty, and the route skipped the player lookup and still answered ok: true.
 * The app said the reset email was on its way and nothing was sent.
 *
 * These drive the real route with the database and Resend stubbed, so the
 * assertions are about which emails actually leave.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "./database.mts";
import { handleBookingApiRoute } from "../booking-core.mts";

const LIVE_ACCOUNTS = ["sam-hale-golf", "clarity-demo-golf"];
const PLAYER_EMAIL = "player@example.test";

type Fixture = {
  /** portal_players rows on the platform, across every business. */
  portalPlayers: Record<string, unknown>[];
};

type Sent = { to: string[]; subject: string; text: string };

/**
 * Answers enough SQL to run the route. portal_players lookups honour the two
 * filters the fix depends on, the account scope and the disabled exclusion, so
 * a test cannot pass by the fake handing back a row the real query would not.
 * The email match is honoured too.
 */
function installDatabase(fixture: Fixture, invited: string[]) {
  const answer = (raw: string, values: unknown[]): unknown[] => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (/^UPDATE portal_players SET invite_token_hash/i.test(text)) {
      invited.push(String(values[values.length - 1]));
      return [];
    }
    if (/FROM portal_players/i.test(text)) {
      let rows = fixture.portalPlayers;
      const scoped = text.match(/account_id = \$(\d+)/);
      if (scoped) rows = rows.filter((row) => row.account_id === values[Number(scoped[1]) - 1]);
      const byEmail = text.match(/LOWER\((?:portal_players\.)?email\) = LOWER\(\$(\d+)\)/);
      if (byEmail) {
        const email = String(values[Number(byEmail[1]) - 1]).toLowerCase();
        rows = rows.filter((row) => String(row.email).toLowerCase() === email);
      }
      if (/status <> 'disabled'/.test(text)) rows = rows.filter((row) => row.status !== "disabled");
      return rows;
    }
    if (/FROM accounts/i.test(text)) {
      return LIVE_ACCOUNTS.map((id) => ({ id, status: "active" }));
    }
    if (/FROM people/i.test(text)) {
      return [{ id: "person-1", name: "Jordan Fisher", email: PLAYER_EMAIL, phone: "" }];
    }
    // No admin_users row: the address is a player's, not a coach's. Everything
    // else is a write, DDL, or settings that may as well be empty.
    return [];
  };

  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = "";
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) text += `$${index + 1}`;
      });
      return answer(text, values);
    },
    pool: {
      async query(text: string, values: unknown[] = []) {
        return { rows: answer(text, values) };
      },
      async connect() {
        return {
          async query(text: string, values: unknown[] = []) {
            return { rows: answer(text, values) };
          },
          release() {},
        };
      },
    },
  });
}

function installResend(sent: Sent[]) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://api.resend.com/emails") {
      sent.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ id: `email-${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected outbound call in test: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function portalPlayer(overrides: Record<string, unknown> = {}) {
  return {
    id: "portal-1",
    account_id: "clarity-demo-golf",
    person_id: "person-1",
    auth_user_id: "5cdec1ad-9bb6-49fb-bce0-b68ea51b6d2c",
    email: PLAYER_EMAIL,
    status: "active",
    invited_at: null,
    activated_at: null,
    last_login_at: null,
    ...overrides,
  };
}

/** What the Clarity Player app sends: no ?business=, just the email. */
async function forgotPassword(email: string) {
  const request = new Request("https://book.example.test/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const response = await handleBookingApiRoute(request, "/api/auth/forgot-password", {} as never);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function withFixture(
  fixture: Fixture,
  run: (sent: Sent[], invited: string[]) => Promise<void>,
) {
  process.env.DATABASE_URL ||= "postgres://stub/stub";
  const previousKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_test";
  const sent: Sent[] = [];
  const invited: string[] = [];
  installDatabase(fixture, invited);
  const restoreFetch = installResend(sent);
  try {
    await run(sent, invited);
  } finally {
    restoreFetch();
    setDatabaseForTests(null);
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  }
}

test("a player of the second live business gets a reset email when the app names no business", async () => {
  await withFixture({ portalPlayers: [portalPlayer()] }, async (sent, invited) => {
    const { status, body } = await forgotPassword(PLAYER_EMAIL);

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.deepEqual(invited, ["portal-1"], "the reset token goes on the player's own row");
    assert.equal(sent.length, 1, "exactly one reset email, not none and not one per business");
    assert.deepEqual(sent[0].to, [PLAYER_EMAIL]);
  });
});

test("revoked portal access gets no reset email, and the answer does not say so", async () => {
  await withFixture(
    { portalPlayers: [portalPlayer({ status: "disabled" })] },
    async (sent, invited) => {
      const { status, body } = await forgotPassword(PLAYER_EMAIL);

      assert.equal(status, 200);
      assert.equal(body.ok, true, "the route must not reveal whether the address exists");
      assert.deepEqual(invited, []);
      assert.equal(sent.length, 0);
    },
  );
});

test("an address nobody has still answers ok and sends nothing", async () => {
  await withFixture({ portalPlayers: [portalPlayer()] }, async (sent, invited) => {
    const { status, body } = await forgotPassword("stranger@example.test");

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(invited, []);
    assert.equal(sent.length, 0);
  });
});
