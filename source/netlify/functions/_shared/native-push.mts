import { createPrivateKey, createSign, randomUUID, sign } from "node:crypto";
import { connect } from "node:http2";

import { getDatabase } from "./database.mts";
import { cleanMessageLanguage } from "./message-language.mts";
import { trimmedEnv } from "./values.mts";

/**
 * Push to the Clarity Booking staff app (booking-app/): Apple's push service
 * for iPhones, Firebase Cloud Messaging for Android.
 *
 * The browser half lives in push-notify.mts and works the same way: devices
 * are stored per business, a message is composed once per language in use,
 * and a device is only forgotten when the push service says it is gone for
 * good. Nothing here knows what a booking is.
 *
 * No SDKs. Both services take a signed JWT and one HTTPS request, and Node's
 * crypto and http2 do both; a Firebase or APNs library would be a large
 * dependency in every function bundle for two requests.
 *
 * Configuration (Netlify environment variables):
 *   APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY  the .p8 key from Apple
 *   APNS_TOPIC         the app's bundle id (default app.claritygolf.booking)
 *   APNS_ENVIRONMENT   "sandbox" for Xcode builds; anything else is production
 *   FCM_SERVICE_ACCOUNT  the Firebase service-account JSON, as one value
 * Either half can be set up without the other.
 */

export type NativePlatform = "ios" | "android";

export type NativePushMessage = {
  title: string;
  body: string;
  /** In-app path opened when the notification is tapped. */
  url?: string;
  /** Notifications sharing a tag replace each other instead of stacking. */
  tag?: string;
};

export type NativePushResult = { sent: number; failed: number; pruned: number };

type StoredDevice = { id: string; platform: NativePlatform; token: string; language: string };

const APNS_DEFAULT_TOPIC = "app.claritygolf.booking";

function db() {
  return getDatabase();
}

export function apnsConfigured() {
  return Boolean(trimmedEnv("APNS_KEY_ID") && trimmedEnv("APNS_TEAM_ID") && trimmedEnv("APNS_PRIVATE_KEY"));
}

export function fcmConfigured() {
  return Boolean(fcmServiceAccount());
}

export function nativePushConfigured() {
  return apnsConfigured() || fcmConfigured();
}

export function cleanNativePlatform(value: unknown): NativePlatform | "" {
  return value === "ios" || value === "android" ? value : "";
}

let tableReady = false;

export async function ensureNativePushDevicesTable() {
  if (tableReady) return;
  await db().sql`
    CREATE TABLE IF NOT EXISTS native_push_devices (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      language TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_sent_at TIMESTAMPTZ
    )
  `;
  await db().sql`
    CREATE INDEX IF NOT EXISTS idx_native_push_devices_account
    ON native_push_devices (account_id)
  `;
  tableReady = true;
}

/**
 * One row per phone. The token is the push service's name for this install,
 * so upserting on it means a phone that registers again (as it does on every
 * launch) refreshes its row instead of adding a second one -- and every
 * duplicate would be a second identical alert.
 */
export async function saveNativePushDevice(input: {
  accountId: string;
  userId: string;
  platform: NativePlatform;
  token: string;
  language?: unknown;
  label?: string;
}) {
  await ensureNativePushDevicesTable();
  await db().sql`
    INSERT INTO native_push_devices (id, account_id, user_id, platform, token, language, label)
    VALUES (
      ${`native-push-${randomUUID()}`},
      ${input.accountId},
      ${input.userId},
      ${input.platform},
      ${input.token},
      ${cleanMessageLanguage(input.language)},
      ${String(input.label || "").slice(0, 200)}
    )
    ON CONFLICT (token) DO UPDATE SET
      account_id = EXCLUDED.account_id,
      user_id = EXCLUDED.user_id,
      platform = EXCLUDED.platform,
      language = EXCLUDED.language,
      label = EXCLUDED.label,
      failure_count = 0,
      last_error = '',
      last_seen_at = NOW()
  `;
}

export async function deleteNativePushDevice(accountId: string, token: string) {
  if (!token) return 0;
  await ensureNativePushDevicesTable();
  const rows = await db().sql`
    DELETE FROM native_push_devices
    WHERE account_id = ${accountId} AND token = ${token}
    RETURNING id
  `;
  return rows.length;
}

export async function hasNativePushDevice(accountId: string, token: string) {
  if (!token) return false;
  await ensureNativePushDevicesTable();
  const rows = await db().sql`
    SELECT 1 FROM native_push_devices WHERE account_id = ${accountId} AND token = ${token} LIMIT 1
  `;
  return rows.length > 0;
}

export async function countNativePushDevices(accountId: string) {
  await ensureNativePushDevicesTable();
  const rows = await db().sql`
    SELECT COUNT(*)::int AS total FROM native_push_devices WHERE account_id = ${accountId}
  `;
  return Number(rows[0]?.total || 0);
}

async function listNativePushDevices(accountId: string): Promise<StoredDevice[]> {
  await ensureNativePushDevicesTable();
  const rows = await db().sql`
    SELECT id, platform, token, language FROM native_push_devices
    WHERE account_id = ${accountId}
    ORDER BY created_at ASC
  `;
  return rows
    .map((row: any) => ({
      id: String(row.id),
      platform: cleanNativePlatform(row.platform),
      token: String(row.token),
      language: String(row.language || ""),
    }))
    .filter((device: { platform: string }): device is StoredDevice => Boolean(device.platform));
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

/**
 * A pasted .p8 or service-account key often arrives with its line breaks
 * written as "\n". Either form works.
 */
export function pemFromEnv(value: string) {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

// ---- Apple --------------------------------------------------------------------

let apnsToken: { value: string; issuedAt: number } | null = null;

/** Apple wants a fresh provider token at most hourly and no more than every 20 minutes. */
export function apnsProviderToken(now = Date.now()) {
  if (apnsToken && now - apnsToken.issuedAt < 40 * 60 * 1000) return apnsToken.value;
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: trimmedEnv("APNS_KEY_ID") }));
  const claims = base64Url(JSON.stringify({ iss: trimmedEnv("APNS_TEAM_ID"), iat: Math.floor(now / 1000) }));
  const key = createPrivateKey(pemFromEnv(trimmedEnv("APNS_PRIVATE_KEY")));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  apnsToken = { value: `${header}.${claims}.${base64Url(signature)}`, issuedAt: now };
  return apnsToken.value;
}

export function apnsRequest(token: string, message: NativePushMessage) {
  return {
    path: `/3/device/${token}`,
    headers: {
      "apns-topic": trimmedEnv("APNS_TOPIC") || APNS_DEFAULT_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      // Twelve hours, like the browser pushes: a booking alert a day late is noise.
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 60 * 60 * 12),
      ...(message.tag ? { "apns-collapse-id": message.tag.slice(0, 64) } : {}),
    },
    body: JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default" },
      url: message.url || "/",
    }),
  };
}

/**
 * Only 410 is "this phone is gone" (the app was deleted or alerts were turned
 * off). A 400 such as BadDeviceToken is also what every device answers when
 * APNS_ENVIRONMENT points at the wrong server, and a configuration mistake
 * must not wipe every registered phone.
 */
export function apnsDeviceGone(status: number) {
  return status === 410;
}

function apnsHost() {
  return trimmedEnv("APNS_ENVIRONMENT") === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
}

async function sendApns(devices: StoredDevice[], payloadFor: (device: StoredDevice) => NativePushMessage) {
  const outcomes = new Map<string, { ok: boolean; status: number; reason: string }>();
  if (!devices.length) return outcomes;
  const client = connect(apnsHost());
  client.on("error", () => undefined);
  try {
    const authorization = `bearer ${apnsProviderToken()}`;
    await Promise.all(
      devices.map(
        (device) =>
          new Promise<void>((resolve) => {
            const request = apnsRequest(device.token, payloadFor(device));
            const stream = client.request({
              ":method": "POST",
              ":path": request.path,
              authorization,
              "content-type": "application/json",
              ...request.headers,
            });
            let status = 0;
            let body = "";
            stream.setEncoding("utf8");
            stream.on("response", (headers) => {
              status = Number(headers[":status"] || 0);
            });
            stream.on("data", (chunk) => {
              body += chunk;
            });
            stream.on("end", () => {
              outcomes.set(device.id, { ok: status === 200, status, reason: body.slice(0, 400) });
              resolve();
            });
            stream.on("error", (error) => {
              outcomes.set(device.id, { ok: false, status: 0, reason: String(error?.message || "apns_failed") });
              resolve();
            });
            stream.setTimeout(10_000, () => stream.close());
            stream.end(request.body);
          }),
      ),
    );
  } finally {
    client.close();
  }
  return outcomes;
}

// ---- Google ---------------------------------------------------------------------

type ServiceAccount = { client_email: string; private_key: string; project_id: string };

function fcmServiceAccount(): ServiceAccount | null {
  const raw = trimmedEnv("FCM_SERVICE_ACCOUNT");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.client_email && parsed?.private_key && parsed?.project_id ? parsed : null;
  } catch {
    return null;
  }
}

let fcmAccess: { value: string; expiresAt: number } | null = null;

/** The signed request Google's token endpoint swaps for an access token. */
export function fcmAssertion(account: ServiceAccount, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64Url(signer.sign(pemFromEnv(account.private_key)))}`;
}

async function fcmAccessToken(account: ServiceAccount) {
  if (fcmAccess && Date.now() < fcmAccess.expiresAt) return fcmAccess.value;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: fcmAssertion(account) }),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) throw new Error(`fcm_token_failed ${response.status} ${data?.error || ""}`.trim());
  fcmAccess = { value: String(data.access_token), expiresAt: Date.now() + (Number(data.expires_in || 3600) - 120) * 1000 };
  return fcmAccess.value;
}

export function fcmMessage(token: string, message: NativePushMessage) {
  return {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      data: { url: message.url || "/" },
      android: {
        priority: "HIGH",
        ttl: `${60 * 60 * 12}s`,
        ...(message.tag ? { notification: { tag: message.tag } } : {}),
      },
    },
  };
}

/**
 * 404 UNREGISTERED is Google saying the install is gone. Other errors, 400
 * included, can be a malformed message or a wrong project, and are kept.
 */
export function fcmDeviceGone(status: number, body: string) {
  return status === 404 || (status === 400 && body.includes("UNREGISTERED"));
}

async function sendFcm(devices: StoredDevice[], payloadFor: (device: StoredDevice) => NativePushMessage) {
  const outcomes = new Map<string, { ok: boolean; status: number; reason: string }>();
  const account = fcmServiceAccount();
  if (!devices.length || !account) return outcomes;
  const accessToken = await fcmAccessToken(account);
  await Promise.all(
    devices.map(async (device) => {
      try {
        const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(fcmMessage(device.token, payloadFor(device))),
        });
        const body = response.ok ? "" : (await response.text().catch(() => "")).slice(0, 400);
        outcomes.set(device.id, { ok: response.ok, status: response.status, reason: body });
      } catch (error: any) {
        outcomes.set(device.id, { ok: false, status: 0, reason: String(error?.message || "fcm_failed") });
      }
    }),
  );
  return outcomes;
}

// ---- Sending --------------------------------------------------------------------

/**
 * Send one message to every staff-app phone the business has registered, each
 * in its own language. Never throws, for the same reason as sendCoachPush: an
 * alert is a courtesy on top of the email, and must not take a booking down.
 */
export async function sendNativeCoachPush(
  accountId: string,
  compose: (language: string) => NativePushMessage,
  fallbackLanguage = "en",
): Promise<NativePushResult> {
  const result: NativePushResult = { sent: 0, failed: 0, pruned: 0 };
  if (!nativePushConfigured()) return result;

  let devices: StoredDevice[] = [];
  try {
    devices = await listNativePushDevices(accountId);
  } catch (error) {
    console.error("native_push:list_failed", accountId, error);
    return result;
  }
  if (!devices.length) return result;

  const messages = new Map<string, NativePushMessage>();
  const payloadFor = (device: StoredDevice) => {
    const language = cleanMessageLanguage(device.language || fallbackLanguage);
    if (!messages.has(language)) messages.set(language, compose(language));
    return messages.get(language)!;
  };

  const ios = apnsConfigured() ? devices.filter((device) => device.platform === "ios") : [];
  const android = fcmConfigured() ? devices.filter((device) => device.platform === "android") : [];
  const [apple, google] = await Promise.all([
    sendApns(ios, payloadFor).catch((error) => {
      console.error("native_push:apns_failed", error);
      return new Map(ios.map((device) => [device.id, { ok: false, status: 0, reason: String(error?.message || "apns_failed") }]));
    }),
    sendFcm(android, payloadFor).catch((error) => {
      console.error("native_push:fcm_failed", error);
      return new Map(android.map((device) => [device.id, { ok: false, status: 0, reason: String(error?.message || "fcm_failed") }]));
    }),
  ]);

  for (const device of [...ios, ...android]) {
    const outcome = (device.platform === "ios" ? apple : google).get(device.id);
    if (!outcome) continue;
    try {
      if (outcome.ok) {
        result.sent += 1;
        await db().sql`
          UPDATE native_push_devices SET last_sent_at = NOW(), failure_count = 0, last_error = '' WHERE id = ${device.id}
        `;
      } else if (device.platform === "ios" ? apnsDeviceGone(outcome.status) : fcmDeviceGone(outcome.status, outcome.reason)) {
        result.pruned += 1;
        await db().sql`DELETE FROM native_push_devices WHERE id = ${device.id}`;
      } else {
        result.failed += 1;
        console.error("native_push:send_failed", device.platform, outcome.status, outcome.reason);
        await db().sql`
          UPDATE native_push_devices
          SET failure_count = failure_count + 1, last_error = ${`${outcome.status} ${outcome.reason}`.slice(0, 400)}
          WHERE id = ${device.id}
        `;
      }
    } catch (error) {
      console.error("native_push:record_failed", device.id, error);
    }
  }

  console.log("native_push:result", JSON.stringify({ accountId, ...result }));
  return result;
}
