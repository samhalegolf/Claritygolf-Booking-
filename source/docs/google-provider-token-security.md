# Google Provider Token Security

## Purpose

Google Calendar and future Google Drive Transfer both need long-lived offline access. Refresh tokens must be encrypted, account-scoped, and held server-side only. Browser responses may show connection status, provider email, scopes, and reconnect state, but never refresh tokens, access tokens, encrypted payloads, or encryption-key metadata.

## Storage Model

`public.google_provider_connections` stores one Google connection per Clarity account:

- `account_id`
- provider identity/email
- encrypted refresh token JSON
- granted scopes JSON
- Calendar/Drive enabled flags
- connection/reconnect/error timestamps

The old `settings.googleCalendarRefreshToken` key is legacy plaintext storage and should be empty after migration.

## Encryption

Refresh tokens are encrypted in `source/netlify/functions/_shared/google-provider.mts` using Node `crypto` with AES-256-GCM.

Payload shape:

```ts
type EncryptedSecret = {
  version: 1
  algorithm: "aes-256-gcm"
  keyId: "v1"
  iv: string
  ciphertext: string
  authTag: string
}
```

Every encryption uses a unique 12-byte IV. Malformed or tampered payloads fail decryption.

## Required Secret

Set this server-only Netlify secret before OAuth or migration:

`GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1`

It must decode to exactly 32 random bytes. Do not prefix it with `VITE_`.

Safe local generation command:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Store the generated value in Netlify environment variables and local `.env` files only. Never commit it.

## Legacy Migration Procedure

1. Deploy the database migration `20260710000100_create_google_provider_connections`.
2. Set `GOOGLE_PROVIDER_TOKEN_ENCRYPTION_KEY_V1`.
3. Log in as an admin.
4. In Settings > Integrations, click `Secure existing token` if shown, or call:

```bash
curl -X POST https://claritygolf.app/api/google-calendar/migrate-provider-token \
  -H "Accept: application/json" \
  -H "Cookie: clarity_session=<admin-session-cookie>"
```

The migration:

- reads `settings.googleCalendarRefreshToken`
- encrypts it into `google_provider_connections`
- verifies it can be decrypted
- clears `settings.googleCalendarRefreshToken` only after the secure write succeeds
- is idempotent

Do not copy plaintext tokens into SQL migrations, logs, tickets, or build output.

## Rollback

If deployment must roll back before migration, the legacy plaintext token remains in `settings.googleCalendarRefreshToken`.

If migration succeeded and rollback is needed, redeploy the previous app version only after confirming whether Calendar reconnect is acceptable. Do not attempt to manually decrypt tokens outside the server environment.

## Calendar Regression Checklist

- `/api/google-calendar/status` returns JSON and does not include secret fields.
- Existing legacy token shows `legacyMigrationRequired` until migrated.
- Migration clears `settings.googleCalendarRefreshToken` only after writing the encrypted provider row.
- `/api/google-calendar/sync` obtains access tokens through the provider service.
- Missing Calendar scope returns a reconnect/scope state, not a generic success.
- Disconnect disables Calendar without deleting future Drive capability.

## Drive Status

Drive upload/import remains disabled until this security foundation is deployed, migrated, and verified. Future Drive work should use the same provider connection and require `https://www.googleapis.com/auth/drive.file` through incremental authorization.

## Key Rotation

The encrypted payload contains `keyId: "v1"`. To rotate keys later, add a new env var and decrypt/re-encrypt records through a controlled server-side rotation job. Do not generate keys at runtime.
