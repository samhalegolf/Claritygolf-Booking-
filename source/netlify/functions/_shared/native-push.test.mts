import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  apnsDeviceGone,
  apnsProviderToken,
  apnsRequest,
  cleanNativePlatform,
  fcmAssertion,
  fcmDeviceGone,
  fcmMessage,
  pemFromEnv,
} from "./native-push.mts";

const message = { title: "New booking · Jane Smith", body: "Private Lesson\nMon 10:00 AM", url: "/", tag: "clarity-booking-appt-1" };

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("only iPhone and Android are platforms", () => {
  assert.equal(cleanNativePlatform("ios"), "ios");
  assert.equal(cleanNativePlatform("android"), "android");
  assert.equal(cleanNativePlatform("web"), "");
  assert.equal(cleanNativePlatform(undefined), "");
});

test("a key pasted with written-out line breaks reads the same as a real one", () => {
  assert.equal(pemFromEnv("-----BEGIN-----\\nabc\\n-----END-----"), "-----BEGIN-----\nabc\n-----END-----");
  assert.equal(pemFromEnv("line one\nline two"), "line one\nline two");
});

test("an Apple alert carries the title, body and tap target, and replaces its own earlier alert", () => {
  const request = apnsRequest("device-token", message);
  assert.equal(request.path, "/3/device/device-token");
  assert.equal(request.headers["apns-push-type"], "alert");
  assert.equal(request.headers["apns-topic"], process.env.APNS_TOPIC || "app.claritygolf.booking");
  assert.equal(request.headers["apns-collapse-id"], "clarity-booking-appt-1");
  const body = JSON.parse(request.body);
  assert.deepEqual(body.aps.alert, { title: message.title, body: message.body });
  assert.equal(body.url, "/");
});

test("an Android alert carries the same, with the tag on the notification", () => {
  const body = fcmMessage("device-token", message);
  assert.equal(body.message.token, "device-token");
  assert.deepEqual(body.message.notification, { title: message.title, body: message.body });
  assert.deepEqual(body.message.data, { url: "/" });
  assert.equal(body.message.android.priority, "HIGH");
  assert.deepEqual(body.message.android.notification, { tag: "clarity-booking-appt-1" });
});

test("a phone is forgotten only when the push service says it is gone for good", () => {
  assert.equal(apnsDeviceGone(410), true);
  // BadDeviceToken is also what every phone says when the server points at the
  // wrong Apple environment; that must not delete them all.
  assert.equal(apnsDeviceGone(400), false);
  assert.equal(apnsDeviceGone(403), false);
  assert.equal(fcmDeviceGone(404, ""), true);
  assert.equal(fcmDeviceGone(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}'), true);
  assert.equal(fcmDeviceGone(400, '{"error":{"status":"INVALID_ARGUMENT"}}'), false);
  assert.equal(fcmDeviceGone(401, ""), false);
});

test("the Apple provider token is an ES256 JWT signed with the .p8 key, reused until it ages", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APNS_KEY_ID = "KEY123";
  process.env.APNS_TEAM_ID = "TEAM456";
  // Pasted the way a Netlify variable often holds it: line breaks written out.
  process.env.APNS_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
  try {
    const now = Date.UTC(2026, 9, 4, 12);
    const token = apnsProviderToken(now);
    const [header, claims, signature] = token.split(".");
    assert.deepEqual(decode(header), { alg: "ES256", kid: "KEY123" });
    assert.deepEqual(decode(claims), { iss: "TEAM456", iat: now / 1000 });
    assert.ok(
      verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
    );
    assert.equal(apnsProviderToken(now + 30 * 60 * 1000), token);
    assert.notEqual(apnsProviderToken(now + 45 * 60 * 1000), token);
  } finally {
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_PRIVATE_KEY;
  }
});

test("the Firebase assertion is an RS256 JWT for the messaging scope, signed with the service account key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = {
    client_email: "push@clarity.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    project_id: "clarity",
  };
  const now = Date.UTC(2026, 9, 4, 12);
  const [header, claims, signature] = fcmAssertion(account, now).split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const body = decode(claims);
  assert.equal(body.iss, account.client_email);
  assert.equal(body.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(body.aud, "https://oauth2.googleapis.com/token");
  assert.equal(body.exp - body.iat, 3600);
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")));
});
