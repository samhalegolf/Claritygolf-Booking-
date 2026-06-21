import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function makeState() {
  const now = new Date();
  return {
    settings: [],
    calendar_items: [],
    people: [{
      id: "existing-person",
      name: "Existing Client",
      email: "Client@Example.com",
      phone: "0210000000",
      notes: "",
      source: "import",
      caddy_profile_id: "caddy-1",
      caddy_profile_url: "https://caddy.claritygolf.app/client/caddy-1",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }],
    admin_users: [{
      id: "admin-1",
      email: "samhalegolf@gmail.com",
      password_hash: "stored-hash",
      password_salt: "stored-salt",
    }],
    admin_sessions: [{
      id: "session-1",
      token_hash: createHash("sha256").update("valid-token").digest("hex"),
      user_id: "admin-1",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: now.toISOString(),
    }],
    admin_password_resets: [],
    notification_history: [],
    notification_webhook_events: [],
  };
}

function parseLiteral(value = "") {
  return decodeURIComponent(value).replace(/^"|"$/g, "");
}

function compare(row, key, operation, value) {
  const actual = row[key];
  if (operation === "eq") return String(actual ?? "") === value;
  if (operation === "ilike") return String(actual ?? "").toLowerCase() === value.toLowerCase();
  if (operation === "gt") return String(actual ?? "") > value;
  if (operation === "gte") return String(actual ?? "") >= value;
  if (operation === "lte") return String(actual ?? "") <= value;
  if (operation === "is") return value === "null" ? actual == null : false;
  if (operation === "not") {
    if (value === "is.null") return actual != null;
    if (value.startsWith("in.(")) {
      const list = value.slice(4, -1).split(",").map(parseLiteral);
      return !list.includes(String(actual));
    }
  }
  return true;
}

function applyFilters(rows, url) {
  let output = [...rows];
  for (const [key, raw] of url.searchParams.entries()) {
    if (["select", "order", "limit", "on_conflict", "or"].includes(key)) continue;
    const dot = raw.indexOf(".");
    if (dot < 0) continue;
    output = output.filter((row) => compare(row, key, raw.slice(0, dot), raw.slice(dot + 1)));
  }
  const order = url.searchParams.get("order");
  if (order) {
    const [field] = order.split(".");
    output.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")));
  }
  const limit = Number(url.searchParams.get("limit") || 0);
  return limit ? output.slice(0, limit) : output;
}

function selectFields(rows, select) {
  if (!select || select === "*") return rows;
  const fields = select.split(",").map((field) => field.trim()).filter(Boolean);
  return rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installSupabaseMock(state, resendCalls) {
  globalThis.Netlify = {
    env: {
      get(name) {
        const values = {
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "service-key",
          CLARITY_ADMIN_EMAIL: "samhalegolf@gmail.com",
          CLARITY_ADMIN_PASSWORD: "bootstrap-password",
          EMAIL_NOTIFICATIONS_ENABLED: "1",
          CLARITY_NOTIFICATION_EMAIL: "samhalegolf@gmail.com",
          CLARITY_CONTACT_EMAIL: "samhalegolf@gmail.com",
          CLARITY_REPLY_TO_EMAIL: "samhalegolf@gmail.com",
          CLARITY_EMAIL_FROM: "Clarity Golf Booking <bookings@claritygolf.app>",
          CLARITY_APP_URL: "https://claritygolf.app",
          RESEND_API_KEY: "test-resend-key",
        };
        return values[name] || "";
      },
    },
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "api.resend.com") {
      const payload = JSON.parse(init.body);
      resendCalls.push({
        payload,
        idempotencyKey: init.headers?.["Idempotency-Key"] || init.headers?.["idempotency-key"] || "",
      });
      return jsonResponse({ id: `resend-${resendCalls.length}` });
    }
    const table = url.pathname.split("/").at(-1);
    if (!(table in state)) throw new Error(`Unknown mock table ${table}: ${url}`);
    const method = String(init.method || "GET").toUpperCase();

    if (method === "GET") {
      return jsonResponse(selectFields(applyFilters(state[table], url), url.searchParams.get("select")));
    }

    const body = init.body ? JSON.parse(init.body) : null;
    if (method === "POST") {
      const incoming = Array.isArray(body) ? body : [body];
      const conflict = url.searchParams.get("on_conflict");
      const prefer = String(init.headers?.Prefer || init.headers?.prefer || "");
      const ignore = prefer.includes("ignore-duplicates");
      const returned = [];
      for (const row of incoming) {
        const index = conflict
          ? state[table].findIndex((candidate) => String(candidate[conflict] ?? "") === String(row[conflict] ?? ""))
          : -1;
        if (index >= 0) {
          if (!ignore) state[table][index] = { ...state[table][index], ...row };
          returned.push(state[table][index]);
        } else {
          state[table].push({ ...row });
          returned.push(row);
        }
      }
      return prefer.includes("return=representation") ? jsonResponse(returned, 201) : emptyResponse(201);
    }

    if (method === "PATCH") {
      const matches = applyFilters(state[table], url);
      for (const row of matches) Object.assign(row, body);
      const prefer = String(init.headers?.Prefer || init.headers?.prefer || "");
      return prefer.includes("return=representation") ? jsonResponse(matches) : emptyResponse();
    }

    if (method === "DELETE") {
      const matches = new Set(applyFilters(state[table], url));
      state[table] = state[table].filter((row) => !matches.has(row));
      return emptyResponse();
    }

    throw new Error(`Unsupported mock request ${method} ${url}`);
  };
}

test("calendar save, repeat save, final cancellation and stale-write protection work together", async () => {
  const state = makeState();
  const resendCalls = [];
  installSupabaseMock(state, resendCalls);

  const functionUrl = pathToFileURL(resolve("netlify/functions/calendar-state.mts"));
  const { default: calendarState } = await import(`${functionUrl.href}?integration=${Date.now()}`);
  const headers = {
    cookie: "clarity_session=valid-token",
    "content-type": "application/json",
    accept: "application/json",
  };

  const initialResponse = await calendarState(new Request("https://claritygolf.app/api/calendar-state", { headers }), {});
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.deepEqual(initial.items, []);
  assert.ok(initial.updatedAt);

  const appointment = {
    id: "appt-1",
    kind: "appointment",
    week: 3,
    day: 2,
    start: 900,
    duration: 60,
    serviceId: "lesson-60",
    client: "Updated Client",
    title: "Updated Client",
    phone: "0221111111",
    email: "client@example.com",
    note: "integration test",
  };

  const saveResponse = await calendarState(new Request("https://claritygolf.app/api/calendar-state", {
    method: "PUT",
    headers,
    body: JSON.stringify({ items: [appointment], replaceItems: true, updatedAt: initial.updatedAt }),
  }), {});
  assert.equal(saveResponse.status, 200, saveResponse.ok ? "" : await saveResponse.clone().text());
  const saved = await saveResponse.json();
  assert.equal(saved.items.length, 1);
  assert.equal(state.people.length, 1, "normalized email must reuse the existing person");
  assert.equal(state.people[0].id, "existing-person");
  assert.equal(state.people[0].name, "Updated Client");
  assert.equal(state.people[0].caddy_profile_id, "caddy-1", "appointment sync must preserve linked profiles");
  assert.equal(state.people[0].caddy_profile_url, "https://caddy.claritygolf.app/client/caddy-1");
  assert.ok(state.notification_history.some((entry) => entry.kind === "booking_client_email" && entry.status === "sent"));
  assert.ok(state.notification_history.some((entry) => entry.kind === "booking_admin_email" && entry.status === "sent"));
  assert.equal(resendCalls.length, 2, "a new coach booking sends one client and one admin email");
  assert.ok(resendCalls.some((call) => call.payload.to.includes("client@example.com")));
  assert.ok(resendCalls.some((call) => call.payload.to.includes("samhalegolf@gmail.com")));

  const repeatResponse = await calendarState(new Request("https://claritygolf.app/api/calendar-state", {
    method: "PUT",
    headers,
    body: JSON.stringify({ items: [appointment], replaceItems: true, updatedAt: saved.updatedAt }),
  }), {});
  assert.equal(repeatResponse.status, 200);
  const repeated = await repeatResponse.json();
  assert.equal(
    state.notification_history.filter((entry) => entry.kind === "booking_client_email").length,
    1,
    "saving an unchanged appointment must not duplicate its booking email",
  );
  assert.equal(resendCalls.length, 2, "an unchanged autosave must not send duplicate email");

  const movedAppointment = { ...appointment, start: 960 };
  const rescheduleResponse = await calendarState(new Request("https://claritygolf.app/api/calendar-state", {
    method: "PUT",
    headers,
    body: JSON.stringify({ items: [movedAppointment], replaceItems: true, updatedAt: repeated.updatedAt }),
  }), {});
  assert.equal(rescheduleResponse.status, 200, rescheduleResponse.ok ? "" : await rescheduleResponse.clone().text());
  const rescheduled = await rescheduleResponse.json();
  assert.equal(resendCalls.length, 4, "a changed lesson time sends client and admin reschedule emails");
  assert.ok(resendCalls.slice(2).every((call) => /rescheduled/i.test(call.payload.subject)));
  assert.ok(state.notification_history.some((entry) => entry.kind === "reschedule_client_email" && entry.status === "sent"));

  const cancelResponse = await calendarState(new Request("https://claritygolf.app/api/calendar-state", {
    method: "PUT",
    headers,
    body: JSON.stringify({ items: [], replaceItems: true, updatedAt: rescheduled.updatedAt }),
  }), {});
  assert.equal(cancelResponse.status, 200, cancelResponse.ok ? "" : await cancelResponse.clone().text());
  const cancelled = await cancelResponse.json();
  assert.deepEqual(cancelled.items, []);
  assert.deepEqual(state.calendar_items, []);
  assert.ok(state.notification_history.some((entry) => entry.kind === "cancellation_client_email" && entry.status === "sent"));
  assert.ok(state.notification_history.some((entry) => entry.kind === "cancellation_admin_email" && entry.status === "sent"));
  assert.equal(resendCalls.length, 6, "cancelling a lesson sends client and admin cancellation emails");
  assert.ok(resendCalls.slice(4).every((call) => /cancelled/i.test(call.payload.subject)));
  assert.ok(resendCalls.every((call) => call.idempotencyKey), "every booking email must have an idempotency key");

  const staleResponse = await calendarState(new Request("https://claritygolf.app/api/calendar-state", {
    method: "PUT",
    headers,
    body: JSON.stringify({ items: [appointment], replaceItems: true, updatedAt: initial.updatedAt }),
  }), {});
  assert.equal(staleResponse.status, 409);
  assert.deepEqual(state.calendar_items, [], "a stale tab must not restore a cancelled lesson");

  const publicFunctionUrl = pathToFileURL(resolve("netlify/functions/public-booking.mts"));
  const { default: publicBooking } = await import(`${publicFunctionUrl.href}?integration=${Date.now()}`);
  const publicResponse = await publicBooking(new Request("https://claritygolf.app/api/public-booking", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      serviceId: "lesson-30",
      week: 5,
      day: 0,
      start: 990,
      firstName: "Public",
      lastName: "Client",
      email: "public.client@example.com",
      phone: "0212223333",
    }),
  }), {});
  assert.equal(publicResponse.status, 200, publicResponse.ok ? "" : await publicResponse.clone().text());
  const publicResult = await publicResponse.json();
  assert.equal(publicResult.ok, true);
  assert.equal(state.calendar_items.length, 1, "public booking must persist to the canonical calendar store");
  assert.equal(state.people.filter((person) => person.email === "public.client@example.com").length, 1);
  assert.equal(resendCalls.length, 8, "public booking sends one client and one admin email");
  assert.ok(publicResult.notifications.every((result) => result.status === "sent"));
  assert.ok(state.notification_history.some((entry) => entry.calendar_item_id === publicResult.appointment.id && entry.kind === "booking_client_email" && entry.status === "sent"));
});
