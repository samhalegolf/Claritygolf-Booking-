# Video Storage Product Model

Video Storage is presented to coaches as two product-level systems:

- **Local Storage** stores durable saved videos on the current computer.
- **Clarity Cloud** transfers saved videos between devices.

Google Drive is the current Clarity Cloud provider. It is not the product model. UI should title the product surface "Clarity Cloud" and keep "Powered by Google Drive" as a provider detail or advanced diagnostic.

## Local Storage

Local Storage uses the managed Clarity Video Library folder when the browser supports File System Access and the coach has granted access. IndexedDB remains the browser cache, recovery layer, and fallback when the managed folder is unavailable.

Local Storage may only show **Ready** after the managed handle exists, permission is granted, the library structure is usable, and a write/read verification succeeds. If the folder is missing, permission is lost, the browser is unsupported, or Clarity is using only IndexedDB recovery, the UI must not call Local Storage Ready.

Common corrective actions live in the Local Storage card:

- Choose folder
- Reconnect folder
- Locate library

Maintenance controls such as change folder, move library, verify library, rescan library, migrate cache, and storage diagnostics belong in Advanced storage diagnostics.

## Clarity Cloud

Clarity Cloud is optional. A Cloud failure must never turn a successful local save into a failed save. Saved video cards should show local and cloud state separately, for example:

- Local - Saved
- Local - Cache only
- Cloud - Not sent
- Cloud - Sending 42%
- Cloud - Ready in Clarity Cloud
- Cloud - Failed - Retry

Clarity Cloud may only show **Ready** when provider connection, required permission, token refresh, transfer folder provisioning, transfer session storage, upload transport, and inbound import into Local Storage are operational. Until inbound import is complete, a connected send path should remain **Beta** rather than Ready.

Provider diagnostics belong in Advanced storage diagnostics:

- Provider
- OAuth connection
- Permission
- Transfer folder readiness
- Upload service readiness
- Chunked transport readiness
- Incoming import readiness
- Last safe error code

Do not expose OAuth tokens, refresh tokens, resumable upload URLs, raw provider JSON, developer-console URLs, stack traces, or internal database ids.

## Save And Transfer Semantics

Manual Save means save locally. It writes to Local Storage first and reports local success independently.

Send to Clarity Cloud is a separate transfer action. Cloud send can fail, pause, or require reconnect while the local saved video remains successful and visible in Player Profiles.

Incoming Cloud items are not fully received until they are imported into Local Storage, verified against the transfer manifest, and recorded in the saved-video library.

## Provider Seam

The product-level health helpers are in `src/storageHealth.ts`:

- `getLocalStorageHealth(...)`
- `getClarityCloudHealth(...)`
- `googleDriveClarityCloudProvider`

The Google Drive routes and transfer functions remain the provider implementation. Future providers should adapt into the same Clarity Cloud health model instead of spreading provider-specific checks through React components.
