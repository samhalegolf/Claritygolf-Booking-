import assert from "node:assert/strict";
import test from "node:test";

import {
  getClarityCloudGoogleConfig,
  getSafeClarityCloudGoogleRuntimeDiagnostic,
  isClarityCloudProviderTokenEncryptionConfigured,
} from "./clarity-cloud-google-config.mts";

function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

test("generic Google client ID and secret resolve", () => {
  const config = getClarityCloudGoogleConfig(undefined, {
    env: env({
      GOOGLE_CLIENT_ID: "generic-id",
      GOOGLE_CLIENT_SECRET: "generic-secret",
      GOOGLE_DRIVE_REDIRECT_URI: "https://claritygolf.app/api/google-drive/callback",
    }),
  });

  assert.equal(config.configured, true);
  assert.equal(config.clientIdSource, "GOOGLE_CLIENT_ID");
  assert.equal(config.clientSecretSource, "GOOGLE_CLIENT_SECRET");
  assert.equal(config.redirectUriSource, "GOOGLE_DRIVE_REDIRECT_URI");
  assert.deepEqual(config.missingFields, []);
});

test("legacy Calendar client ID and secret resolve for Clarity Cloud", () => {
  const config = getClarityCloudGoogleConfig(undefined, {
    env: env({
      GOOGLE_CALENDAR_CLIENT_ID: "legacy-id",
      GOOGLE_CALENDAR_CLIENT_SECRET: "legacy-secret",
      GOOGLE_CALENDAR_REDIRECT_URI: "https://claritygolf.app/api/google-calendar/callback",
    }),
  });

  assert.equal(config.configured, true);
  assert.equal(config.clientIdSource, "GOOGLE_CALENDAR_CLIENT_ID");
  assert.equal(config.clientSecretSource, "GOOGLE_CALENDAR_CLIENT_SECRET");
  assert.equal(config.redirectUriSource, "GOOGLE_CALENDAR_REDIRECT_URI");
});

test("generic names take precedence over legacy Calendar names", () => {
  const config = getClarityCloudGoogleConfig(undefined, {
    env: env({
      GOOGLE_CLIENT_ID: "generic-id",
      GOOGLE_CALENDAR_CLIENT_ID: "legacy-id",
      GOOGLE_CLIENT_SECRET: "generic-secret",
      GOOGLE_CALENDAR_CLIENT_SECRET: "legacy-secret",
    }),
  });

  assert.equal(config.clientId, "generic-id");
  assert.equal(config.clientSecret, "generic-secret");
  assert.equal(config.clientIdSource, "GOOGLE_CLIENT_ID");
  assert.equal(config.clientSecretSource, "GOOGLE_CLIENT_SECRET");
});

test("missing client ID reports only clientId", () => {
  const config = getClarityCloudGoogleConfig(undefined, {
    env: env({ GOOGLE_CLIENT_SECRET: "generic-secret" }),
  });

  assert.equal(config.configured, false);
  assert.deepEqual(config.missingFields, ["clientId"]);
});

test("missing client secret reports only clientSecret", () => {
  const config = getClarityCloudGoogleConfig(undefined, {
    env: env({ GOOGLE_CLIENT_ID: "generic-id" }),
  });

  assert.equal(config.configured, false);
  assert.deepEqual(config.missingFields, ["clientSecret"]);
});

test("encryption key absence is separate from Google OAuth configuration", () => {
  const config = getClarityCloudGoogleConfig(undefined, {
    env: env({
      GOOGLE_CLIENT_ID: "generic-id",
      GOOGLE_CLIENT_SECRET: "generic-secret",
    }),
  });

  assert.equal(config.configured, true);
  assert.equal(isClarityCloudProviderTokenEncryptionConfigured({ env: env({}) }), false);
});

test("production callback fallback remains valid", () => {
  const config = getClarityCloudGoogleConfig(new Request("https://claritygolf.app/api/video-transfer/diagnostics"), {
    env: env({
      GOOGLE_CLIENT_ID: "generic-id",
      GOOGLE_CLIENT_SECRET: "generic-secret",
    }),
  });

  assert.equal(config.redirectUri, "https://claritygolf.app/api/google-drive/callback");
  assert.equal(config.redirectUriSource, "production-safe-callback-fallback");
  assert.equal(config.configured, true);
});

test("safe runtime diagnostics expose sources but no values or lengths", () => {
  const diagnostic = getSafeClarityCloudGoogleRuntimeDiagnostic(undefined, {
    env: env({
      GOOGLE_CLIENT_ID: "generic-id-secret-value",
      GOOGLE_CLIENT_SECRET: "generic-secret-value",
      GOOGLE_DRIVE_REDIRECT_URI: "https://claritygolf.app/api/google-drive/callback",
      GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1: "encryption-key-value",
    }),
  });
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.googleClientIdPresent, true);
  assert.equal(diagnostic.googleClientSecretPresent, true);
  assert.equal(diagnostic.driveRedirectUriPresent, true);
  assert.equal(diagnostic.encryptionKeyPresent, true);
  assert.equal("clientId" in diagnostic, false);
  assert.equal("clientSecret" in diagnostic, false);
  assert.equal(serialized.includes("generic-id-secret-value"), false);
  assert.equal(serialized.includes("generic-secret-value"), false);
  assert.equal(serialized.includes("encryption-key-value"), false);
});
