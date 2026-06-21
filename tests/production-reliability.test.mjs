import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let importCounter = 0;

async function freshAdapter() {
  globalThis.Netlify = {
    env: {
      get(name) {
        if (name === "SUPABASE_URL") return "https://example.supabase.co";
        if (name === "SUPABASE_SERVICE_ROLE_KEY") return "service-key";
        return "";
      },
    },
  };
  const url = pathToFileURL(resolve(root, "netlify/functions/local-db/supabase-storage.mjs"));
  const module = await import(`${url.href}?test=${importCounter++}`);
  return module.getSupabaseDatabase();
}

function jsonResponse(value, status = 200) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("people writes reuse the existing person id for a duplicate normalized email", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/people?select=*&email=ilike.")) {
      return jsonResponse([{
        id: "existing-person",
        name: "Existing Name",
        email: "client@example.com",
        phone: "0210000000",
        caddy_profile_id: "profile-1",
        created_at: "2026-01-01T00:00:00.000Z",
      }]);
    }
    if (String(url).includes("/people?on_conflict=id")) return jsonResponse(null, 201);
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const db = await freshAdapter();
  const client = await db.pool.connect();
  await client.query(
    "INSERT INTO people (id, name, email, phone, notes, source, caddy_profile_id, caddy_profile_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["new-generated-id", "Updated Name", "client@example.com", "0221111111", "Lesson", "appointment", "", ""],
  );

  const post = calls.find((call) => call.init.method === "POST");
  assert.ok(post, "expected an upsert");
  const [body] = JSON.parse(post.init.body);
  assert.equal(body.id, "existing-person");
  assert.equal(body.email, "client@example.com");
  assert.equal(body.name, "Updated Name");
  assert.equal(body.caddy_profile_id, "profile-1");
});

test("calendar replacement deletes rows not present in the new snapshot", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse(null, 204);
  };
  const db = await freshAdapter();
  const client = await db.pool.connect();
  await client.query("DELETE FROM calendar_items WHERE NOT (id = ANY($1::text[]))", [["appt-1", "appt-2"]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "DELETE");
  assert.match(calls[0].url, /id=not\.in\.\(%22appt-1%22,%22appt-2%22\)|id=not\.in\.\("appt-1","appt-2"\)/);
});

test("an empty replacement deletes the final calendar row", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse(null, 204);
  };
  const db = await freshAdapter();
  const client = await db.pool.connect();
  await client.query("DELETE FROM calendar_items");
  assert.equal(calls[0].init.method, "DELETE");
  assert.match(calls[0].url, /id=not\.is\.null/);
});

test("calendar-state delegates to the canonical booking core", async () => {
  const source = await readFile(resolve(root, "netlify/functions/calendar-state.mts"), "utf8");
  assert.match(source, /handleBookingApiRoute/);
  assert.match(source, /"\/api\/calendar-state"/);
  assert.doesNotMatch(source, /on_conflict=id/);
});

test("booking core handles an empty full replacement", async () => {
  const source = await readFile(resolve(root, "netlify/functions/booking-core.mts"), "utf8");
  assert.match(source, /if \(options\.replaceItems === true\)/);
  assert.match(source, /else \{[\s\S]*DELETE FROM calendar_items/);
});

test("booking core protects reset passwords from environment reseeding", async () => {
  const source = await readFile(resolve(root, "netlify/functions/booking-core.mts"), "utf8");
  const start = source.indexOf("async function ensureAdminUser");
  const end = source.indexOf("async function ensureNotificationHistoryTable", start);
  const block = source.slice(start, end);
  assert.match(block, /if \(existing\.length\) return/);
  assert.doesNotMatch(block, /UPDATE admin_users/);
});

test("calendar changes include booking, reschedule and cancellation notifications", async () => {
  const source = await readFile(resolve(root, "netlify/functions/booking-core.mts"), "utf8");
  const start = source.indexOf("function notificationJobsForCalendarChange");
  const end = source.indexOf("async function sendCalendarChangeNotifications", start);
  const block = source.slice(start, end);
  assert.match(block, /kind: "booking"/);
  assert.match(block, /kind: "reschedule"/);
  assert.match(block, /kind: "cancellation"/);
});

test("frontend serializes calendar writes", async () => {
  const source = await readFile(resolve(root, "src/App.tsx"), "utf8");
  assert.match(source, /calendarSaveQueueRef/);
  assert.match(source, /calendarStateVersionRef\.current/);
  assert.match(source, /lastPersistedCalendarFingerprintRef/);
});

test("frontend does not feed save-response items back into autosave state", async () => {
  const source = await readFile(resolve(root, "src/App.tsx"), "utf8");
  const start = source.indexOf("async function runSave");
  const end = source.indexOf("const queuedSave", start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /setItems\(data\.items\)/);
});

test("frontend verifies a mobile/interrupted save against live state", async () => {
  const source = await readFile(resolve(root, "src/App.tsx"), "utf8");
  assert.match(source, /async function verifyLiveSnapshot/);
  assert.match(source, /calendarItemsFingerprint\(data\.items\) === fingerprint/);
});

test("frontend blocks stale writes after a real concurrency conflict", async () => {
  const source = await readFile(resolve(root, "src/App.tsx"), "utf8");
  assert.match(source, /calendarSaveConflictRef\.current = true/);
  assert.match(source, /calendarSaveConflictRef\.current \|\| calendarSaveVersionRef\.current === saveVersion/);
  assert.match(source, /Reload the calendar before making more changes/);
});

test("quick booking locks the deliberately selected client", async () => {
  const source = await readFile(resolve(root, "src/App.tsx"), "utf8");
  assert.match(source, /quickSelectedClientId/);
  assert.match(source, /setQuickSelectedClientId\(client\.id\)/);
  assert.match(source, /if \(quickSelectedClient \|\| !quickClientHasInput\) return null/);
});

test("login does not accept the old environment password over a reset password", async () => {
  const source = await readFile(resolve(root, "netlify/functions/auth-login.mts"), "utf8");
  assert.match(source, /Once a stored password exists/);
  assert.doesNotMatch(source, /if \(!user \|\| matchesEnvPassword\)/);
});

test("password reset revokes old sessions before creating the new one", async () => {
  const source = await readFile(resolve(root, "netlify/functions/auth-reset-password.mts"), "utf8");
  const deleteIndex = source.indexOf('method: "DELETE"');
  const insertIndex = source.indexOf('method: "POST"', deleteIndex);
  assert.ok(deleteIndex >= 0 && insertIndex > deleteIndex);
});

test("the catch-all API excludes every dedicated notification, import and webhook route", async () => {
  const source = await readFile(resolve(root, "netlify/functions/booking-api.mts"), "utf8");
  for (const path of [
    "/api/public-booking-notifications",
    "/api/people/import",
    "/api/people/import-lite",
    "/api/resend-webhook",
  ]) {
    assert.match(source, new RegExp(`"${path.replaceAll("/", "\\/")}"`));
  }
});
