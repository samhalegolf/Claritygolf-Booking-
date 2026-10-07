import assert from "node:assert/strict";
import test from "node:test";

import { setDatabaseForTests } from "./database.mts";
import { handleCoachAuthSession } from "./auth-session-handler.mts";

const AUTH_USER_ID = "96c0bb5e-63e6-41cf-acd0-e43d9fce8e42";
const ACCOUNT_ID = "performance-test-golf";

type DatabaseFixture = {
  memberships?: Record<string, unknown>[];
};

function installDatabase({ memberships }: DatabaseFixture = {}) {
  const statements: string[] = [];
  setDatabaseForTests({
    async sql(strings: TemplateStringsArray, ...values: unknown[]) {
      let text = "";
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) text += `$${index + 1}`;
      });
      const normalized = text.replace(/\s+/g, " ").trim();
      statements.push(normalized);

      if (/FROM admin_sessions/i.test(normalized)) {
        return [{
          auth_user_id: AUTH_USER_ID,
          user_id: "admin-1",
          email: "coach@example.test",
          expires_at: "2099-01-01T00:00:00.000Z",
          active_account_id: "",
        }];
      }
      if (/FROM account_memberships/i.test(normalized)) {
        return memberships ?? [{
          id: "membership-1",
          account_id: ACCOUNT_ID,
          role: "owner",
          coach_id: ACCOUNT_ID,
        }];
      }
      if (/FROM settings/i.test(normalized)) {
        return [
          { key: "accountId", value: ACCOUNT_ID },
          { key: "accountBusinessName", value: "Fast Fairways" },
          { key: "accountCoachName", value: "Casey Coach" },
        ];
      }
      throw new Error(`unexpected SQL in lightweight session path: ${normalized}`);
    },
    pool: {} as never,
  });
  return statements;
}

function request() {
  return new Request("https://booking.example.test/api/auth/session", {
    headers: { cookie: "clarity_session=test-token" },
  });
}

test("lightweight coach session returns the workspace without schema work", async (t) => {
  t.after(() => setDatabaseForTests(null));
  const statements = installDatabase();

  const response = await handleCoachAuthSession(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.authenticated, true);
  assert.equal(body.role, "coach");
  assert.equal(body.accountRole, "owner");
  assert.equal(body.accountId, ACCOUNT_ID);
  assert.equal(body.workspace?.account?.businessName, "Fast Fairways");
  assert.equal(body.workspace?.currentUser?.name, "Casey Coach");
  assert.match(response.headers.get("server-timing") || "", /session;dur=/);
  assert.match(response.headers.get("server-timing") || "", /membership;dur=/);
  assert.match(response.headers.get("server-timing") || "", /workspace;dur=/);
  assert.match(response.headers.get("server-timing") || "", /total;dur=/);
  assert.equal(statements.length, 3);
  assert.equal(
    statements.some((statement) => /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i.test(statement)),
    false,
  );
});

test("a session without a workspace stays a 200 guest response", async (t) => {
  t.after(() => setDatabaseForTests(null));
  const statements = installDatabase({ memberships: [] });

  const response = await handleCoachAuthSession(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.authenticated, false);
  assert.equal(body.role, "guest");
  assert.equal(body.error, "membership_required");
  assert.equal(statements.length, 2);
  assert.doesNotMatch(response.headers.get("server-timing") || "", /workspace;dur=/);
});
