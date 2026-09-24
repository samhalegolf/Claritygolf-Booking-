import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  credentialReaderFor,
  isTenantIntegration,
  openCredential,
  sealCredential,
  webhookUrlForAccount,
} from "./integration-credentials.mts";
import { candidateOptixResourceIds, DUAL_HANDED_RESOURCE_IDS } from "./optix-auto-select.mts";
import { readOptixReconcileConfig } from "./optix-reconcile.mts";

const ORIGINAL = "sam-hale-golf";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const before: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    before[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a saved credential round-trips through encryption and is not stored in the clear", () => {
  withEnv({ INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") }, () => {
    const sealed = sealCredential("optix_org_token_123");
    assert.equal(sealed.keyId, "ic1");
    assert.equal(JSON.stringify(sealed).includes("optix_org_token_123"), false);
    assert.equal(openCredential(JSON.parse(JSON.stringify(sealed))), "optix_org_token_123");
  });
});

test("with no dedicated key, the existing Google token key seals credentials", () => {
  withEnv(
    {
      INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: undefined,
      GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1: randomBytes(32).toString("base64url"),
    },
    () => {
      const sealed = sealCredential("akahu_user_token");
      assert.equal(sealed.keyId, "google-v1");
      assert.equal(openCredential(sealed), "akahu_user_token");
    },
  );
});

test("no encryption key refuses to save rather than storing plaintext", () => {
  withEnv({ INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: undefined, GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1: undefined }, () => {
    assert.throws(() => sealCredential("anything"), (error: { code?: string }) => error.code === "CREDENTIAL_ENCRYPTION_KEY_MISSING");
  });
});

test("a tampered credential does not decrypt", () => {
  withEnv({ INTEGRATION_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64") }, () => {
    const sealed = sealCredential("secret-value");
    const flipped = Buffer.from(sealed.ciphertext, "base64url");
    flipped[0] ^= 1;
    assert.throws(() => openCredential({ ...sealed, ciphertext: flipped.toString("base64url") }));
  });
});

test("another business never falls back to the original workspace's env credentials", () => {
  withEnv({ OPTIX_ORGANIZATION_TOKEN: "original-org-token", AKAHU_APP_TOKEN: "original-app-token" }, () => {
    for (const accountId of ["acme-golf", "sam-hale-golf-sandbox", ""]) {
      const read = credentialReaderFor(accountId, {});
      assert.equal(read("OPTIX_ORGANIZATION_TOKEN"), "", accountId);
      assert.equal(read("AKAHU_APP_TOKEN"), "", accountId);
    }
  });
});

test("the original workspace keeps its env credentials until it saves its own", () => {
  withEnv({ OPTIX_ORGANIZATION_TOKEN: "original-org-token" }, () => {
    assert.equal(credentialReaderFor(ORIGINAL, {})("OPTIX_ORGANIZATION_TOKEN"), "original-org-token");
    assert.equal(
      credentialReaderFor(ORIGINAL, { OPTIX_ORGANIZATION_TOKEN: "saved-token" })("OPTIX_ORGANIZATION_TOKEN"),
      "saved-token",
    );
  });
});

test("a business's saved value is what it reads, and deployment settings still pass through", () => {
  withEnv({ OPTIX_ORGANIZATION_TOKEN: "original-org-token", CLARITY_TIMEZONE: "Pacific/Auckland" }, () => {
    const read = credentialReaderFor("acme-golf", { OPTIX_ORGANIZATION_TOKEN: "acme-token" });
    assert.equal(read("OPTIX_ORGANIZATION_TOKEN"), "acme-token");
    assert.equal(read("CLARITY_TIMEZONE"), "Pacific/Auckland");
  });
});

test("only integrations a business connects itself can hold stored credentials", () => {
  assert.equal(isTenantIntegration("optix"), true);
  assert.equal(isTenantIntegration("akahu"), true);
  assert.equal(isTenantIntegration("stripe"), true);
  assert.equal(isTenantIntegration("resend"), false);
  assert.equal(isTenantIntegration("caddy"), false);
});

test("each business registers its own webhook URL; the original keeps the bare one", () => {
  assert.equal(
    webhookUrlForAccount("https://claritygolf.app", "/api/optix-webhook", "acme-golf"),
    "https://claritygolf.app/api/optix-webhook?account=acme-golf",
  );
  assert.equal(
    webhookUrlForAccount("https://claritygolf.app", "/api/optix-webhook", ORIGINAL),
    "https://claritygolf.app/api/optix-webhook",
  );
});

test("an Optix config carries the business's reader, so every call uses its token", () => {
  const read = credentialReaderFor("acme-golf", { OPTIX_MEMBER_ID: "m-1", OPTIX_OWNER_USER_ID: "u-1" });
  const config = readOptixReconcileConfig(read, { originalWorkspace: false });
  assert.equal(config.read, read);
  assert.equal(config.memberId, "m-1");
  assert.equal(config.originalWorkspace, false);
});

test("a left-hander at another business is never booked into the original workspace's bays", () => {
  const standardBays = { enabled: true, preferredResourceIds: ["b-1", "b-2"] };
  assert.deepEqual(
    candidateOptixResourceIds({ bookingType: standardBays, leftHandedPlayer: true, dualHandedFallback: [] }),
    [],
  );
  assert.deepEqual(
    candidateOptixResourceIds({ bookingType: standardBays, leftHandedPlayer: true }),
    DUAL_HANDED_RESOURCE_IDS,
  );
});
