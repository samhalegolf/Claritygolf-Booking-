import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  decryptRefreshToken,
  encryptRefreshToken,
  googleConnectionFailureCode,
  hasGoogleScopes,
  mergeGoogleScopes,
} from "./google-provider.mts";

process.env.GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64url");

function tamperBase64Url(value: string) {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = bytes[0] ^ 1;
  return bytes.toString("base64url");
}

test("encrypt/decrypt round trip uses authenticated AES-GCM payload", () => {
  const encrypted = encryptRefreshToken("refresh-token-value");

  assert.equal(encrypted.version, 1);
  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.equal(encrypted.keyId, "v1");
  assert.notEqual(encrypted.ciphertext, "refresh-token-value");
  assert.equal(decryptRefreshToken(encrypted), "refresh-token-value");
});

test("same plaintext produces different ciphertext because IV is unique", () => {
  const left = encryptRefreshToken("same-token");
  const right = encryptRefreshToken("same-token");

  assert.notEqual(left.iv, right.iv);
  assert.notEqual(left.ciphertext, right.ciphertext);
});

test("tampered ciphertext fails authentication", () => {
  const encrypted = encryptRefreshToken("refresh-token-value");

  assert.throws(
    () => decryptRefreshToken({ ...encrypted, ciphertext: tamperBase64Url(encrypted.ciphertext) }),
    /could not be decrypted|payload is invalid/i,
  );
});

test("tampered auth tag fails authentication", () => {
  const encrypted = encryptRefreshToken("refresh-token-value");

  assert.throws(
    () => decryptRefreshToken({ ...encrypted, authTag: tamperBase64Url(encrypted.authTag) }),
    /could not be decrypted|payload is invalid/i,
  );
});

test("malformed payload fails validation", () => {
  assert.throws(() => decryptRefreshToken({ version: 2 }), /invalid|malformed/i);
});

test("wrong key fails decryption", () => {
  const encrypted = encryptRefreshToken("refresh-token-value");
  process.env.GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64url");

  assert.throws(() => decryptRefreshToken(encrypted), /could not be decrypted/i);
});

test("scope helpers merge deterministically and detect missing scopes", () => {
  const scopes = mergeGoogleScopes(["b", "a"], ["a", "c"]);

  assert.deepEqual(scopes, ["a", "b", "c"]);
  assert.equal(hasGoogleScopes({ grantedScopes: scopes }, ["a", "c"]), true);
  assert.equal(hasGoogleScopes({ grantedScopes: scopes }, ["a", "d"]), false);
});


// The failure that hid for three days (17–20 Aug 2026): every Calendar write
// came back 403 insufficientPermissions, because the token Google minted was
// narrower than the scopes Clarity had recorded at consent time. Nothing read
// that rejection, so the connection kept reporting "connected".
test("a scope rejection and a lost grant are the only failures that damn the connection", () => {
  assert.equal(googleConnectionFailureCode(403, "insufficientPermissions"), "GOOGLE_SCOPE_MISSING");
  assert.equal(googleConnectionFailureCode(401, ""), "GOOGLE_RECONNECT_REQUIRED");
});

test("a busy minute is not a broken connection", () => {
  // Most 403s are throttling. Marking these would tell the coach to reconnect
  // a credential that is working perfectly, so they are deliberately ignored.
  assert.equal(googleConnectionFailureCode(403, "rateLimitExceeded"), null);
  assert.equal(googleConnectionFailureCode(403, "userRateLimitExceeded"), null);
  assert.equal(googleConnectionFailureCode(429, ""), null);
  assert.equal(googleConnectionFailureCode(500, ""), null);
  assert.equal(googleConnectionFailureCode(503, ""), null);
  // A missing event is about the event, not the grant.
  assert.equal(googleConnectionFailureCode(404, "notFound"), null);
  assert.equal(googleConnectionFailureCode(200, ""), null);
});
