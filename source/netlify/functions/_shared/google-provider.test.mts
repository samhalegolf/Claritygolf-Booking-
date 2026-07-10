import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  decryptRefreshToken,
  encryptRefreshToken,
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
