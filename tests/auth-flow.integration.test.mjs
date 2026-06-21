import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const adminEmail = "samhalegolf@gmail.com";
const environmentPassword = "EnvironmentBootstrapPassword!";
const originalPassword = "OriginalStoredPassword!";
const replacementPassword = "ReplacementPassword!";

function passwordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  return { password_hash: scryptSync(password, salt, 64).toString("hex"), password_salt: salt };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function empty(status = 204) {
  return new Response(null, { status });
}

function applyQuery(rows, url) {
  let output = [...rows];
  for (const [key, raw] of url.searchParams.entries()) {
    if (["select", "limit", "order", "on_conflict"].includes(key)) continue;
    const dot = raw.indexOf(".");
    if (dot < 0) continue;
    const operation = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    output = output.filter((row) => {
      const actual = row[key];
      if (operation === "eq") return String(actual ?? "") === value;
      if (operation === "gt") return String(actual ?? "") > value;
      if (operation === "is" && value === "null") return actual == null;
      return true;
    });
  }
  const limit = Number(url.searchParams.get("limit") || 0);
  return limit ? output.slice(0, limit) : output;
}

function selectFields(rows, selection) {
  if (!selection || selection === "*") return rows;
  const fields = selection.split(",").map((field) => field.trim()).filter(Boolean);
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
}

function cookieToken(setCookie) {
  const match = String(setCookie || "").match(/clarity_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

test("forgot, reset, login, session and logout form one working recovery flow", async () => {
  const stored = passwordRecord(originalPassword);
  const state = {
    admin_users: [{
      id: "admin-1",
      email: adminEmail,
      ...stored,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
    admin_sessions: [{
      id: "old-session",
      token_hash: hashToken("old-browser-token"),
      user_id: "admin-1",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
    }],
    admin_password_resets: [],
  };
  let resetToken = "";

  globalThis.Netlify = {
    env: {
      get(name) {
        const values = {
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-key",
          CLARITY_ADMIN_EMAIL: adminEmail,
          CLARITY_ADMIN_PASSWORD: environmentPassword,
          CLARITY_APP_URL: "https://claritygolf.app",
          RESEND_API_KEY: "test-resend-key",
          CLARITY_EMAIL_FROM: "Clarity Golf Booking <bookings@claritygolf.app>",
          CLARITY_REPLY_TO_EMAIL: adminEmail,
        };
        return values[name] || "";
      },
    },
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "api.resend.com") {
      const payload = JSON.parse(init.body);
      assert.equal(payload.to, adminEmail);
      const href = String(payload.html).match(/href="([^"]+)"/)?.[1] || "";
      resetToken = new URL(href).searchParams.get("reset") || "";
      assert.ok(resetToken, "reset email must contain a tokenized reset URL");
      return json({ id: "resend-test-id" });
    }

    const table = url.pathname.split("/").at(-1);
    if (!(table in state)) throw new Error(`Unknown auth mock table ${table}: ${url}`);
    const method = String(init.method || "GET").toUpperCase();

    if (method === "GET") {
      return json(selectFields(applyQuery(state[table], url), url.searchParams.get("select")));
    }

    const body = init.body ? JSON.parse(init.body) : null;
    if (method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const conflict = url.searchParams.get("on_conflict");
      const prefer = String(init.headers?.Prefer || init.headers?.prefer || "");
      for (const row of rows) {
        const existingIndex = conflict
          ? state[table].findIndex((candidate) => String(candidate[conflict] ?? "") === String(row[conflict] ?? ""))
          : -1;
        if (existingIndex >= 0) state[table][existingIndex] = { ...state[table][existingIndex], ...row };
        else state[table].push({ ...row });
      }
      return prefer.includes("return=representation") ? json(rows, 201) : empty(201);
    }

    if (method === "PATCH") {
      const matches = applyQuery(state[table], url);
      for (const row of matches) Object.assign(row, body);
      return empty();
    }

    if (method === "DELETE") {
      const matches = new Set(applyQuery(state[table], url));
      state[table] = state[table].filter((row) => !matches.has(row));
      return empty();
    }

    throw new Error(`Unsupported auth mock request ${method} ${url}`);
  };

  async function load(name) {
    const url = pathToFileURL(resolve(`netlify/functions/${name}.mts`));
    return (await import(`${url.href}?auth=${Date.now()}-${name}`)).default;
  }

  const forgotPassword = await load("auth-forgot-password");
  const resetPassword = await load("auth-reset-password");
  const login = await load("auth-login");
  const session = await load("auth-session");
  const logout = await load("auth-logout");

  const forgotResponse = await forgotPassword(new Request("https://claritygolf.app/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail }),
  }));
  assert.equal(forgotResponse.status, 200, await forgotResponse.clone().text());
  assert.ok(resetToken);
  assert.equal(state.admin_password_resets.length, 1);

  const resetResponse = await resetPassword(new Request("https://claritygolf.app/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: resetToken, password: replacementPassword }),
  }));
  assert.equal(resetResponse.status, 200, await resetResponse.clone().text());
  const resetCookie = resetResponse.headers.get("set-cookie");
  assert.ok(cookieToken(resetCookie));
  assert.equal(state.admin_sessions.length, 1, "password reset must revoke every older session");
  assert.notEqual(state.admin_sessions[0].id, "old-session");
  assert.ok(state.admin_password_resets[0].used_at);

  for (const rejectedPassword of [environmentPassword, originalPassword]) {
    const response = await login(new Request("https://claritygolf.app/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: rejectedPassword }),
    }));
    assert.equal(response.status, 401, "old/bootstrap passwords must not overwrite the reset password");
  }

  const loginResponse = await login(new Request("https://claritygolf.app/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: replacementPassword }),
  }));
  assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
  const loginToken = cookieToken(loginResponse.headers.get("set-cookie"));
  assert.ok(loginToken);

  const sessionResponse = await session(new Request("https://claritygolf.app/api/auth/session", {
    headers: { cookie: `clarity_session=${loginToken}` },
  }));
  assert.equal(sessionResponse.status, 200);
  assert.deepEqual(await sessionResponse.json(), { authenticated: true, email: adminEmail });

  const logoutResponse = await logout(new Request("https://claritygolf.app/api/auth/logout", {
    method: "POST",
    headers: { cookie: `clarity_session=${loginToken}` },
  }));
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.equal(state.admin_sessions.some((entry) => entry.token_hash === hashToken(loginToken)), false);
});
