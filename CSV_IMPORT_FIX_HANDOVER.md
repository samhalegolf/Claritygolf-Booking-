# CSV Client Import Fix + Admin-Safe Import Rebuild

## What changed

This update replaces the rough one-button CSV import with a staged admin workflow and hardens the server-side import path.

### Frontend

Updated `src/App.tsx`:

- Added robust CSV parsing that supports quoted fields and uploaded `.csv` files.
- Added header auto-mapping for common field variations:
  - First Name / first_name / First
  - Last Name / Surname / Last
  - Name / Full Name / Client
  - Phone / Mobile / Phone Number
  - Email / Email Address
  - Notes
  - Days Since Last Appointment
- Added preview rows with statuses:
  - will create
  - will update
  - warning
  - duplicate
  - invalid
- Added row selection / deselection.
- Added staged UI:
  1. Paste or upload CSV
  2. Review mapping
  3. Review clients
  4. Import selected clients
- Removed the confusing duplicate import actions from the client import panels.
- Added visible admin auth state:
  - Checking admin access...
  - Admin verified
  - Admin access required...
- Import is disabled unless admin is verified.
- Added import modes:
  - Create new clients only
  - Update existing clients
  - Create new and update existing
- Added result summary and failed-row CSV download.
- Preserves pasted CSV after auth/import failure.

Updated `src/styles.css`:

- Added styles for the CSV auth state, staged import panel, preview table, status rows, toolbar, and result summary.

### Server

Updated `netlify/functions/booking-core.mts`:

- Kept `/api/people/import` behind the existing `/api/*` admin gate.
- Reworked import execution to be row-level safe:
  - Valid rows continue even if another row fails.
  - Import returns `created`, `updated`, `skipped`, `failed`, `errors`, `results`, and the refreshed people list.
- Added safer duplicate matching:
  - existing id
  - exact email match
  - normalised phone match
  - name + email/phone match
- Added import mode support:
  - `create_only`
  - `update_existing`
  - `upsert`
- Prevents blank CSV values from wiping existing stored values.
- Appends imported notes to existing notes rather than overwriting them.
- Preserves “Days Since Last Appointment” by adding it into notes if there is no dedicated DB column.

## Important notes

- The existing app uses a custom admin session cookie (`clarity_session`) backed by `admin_sessions`, not Supabase Auth client sessions.
- The immediate failure `Admin login required` was happening at the protected API write layer, while the UI still presented parsed rows as importable.
- This patch makes that state explicit in the UI and keeps the server-side admin check in place.
- I did not add a new database column for `daysSinceLastAppointment`; it is preserved in notes as:

```txt
Imported CSV field: Days Since Last Appointment: 280
```

## Validation performed

Ran:

```bash
npm run build
```

Build passed successfully.

## Follow-up to verify on live

After deploy, test:

1. Log in as admin.
2. Refresh admin/settings/client import page.
3. Confirm it still says `Admin verified`.
4. Paste/upload a CSV with 700+ rows.
5. Confirm preview loads and invalid/duplicate rows are marked.
6. Import selected clients.
7. Re-import the same CSV and confirm it updates/skips instead of creating duplicates.
8. Log out or expire the session and confirm import buttons are disabled with a clear admin access message.

## 2026-06-18 White Screen Runtime Fix

After the Netlify registry fix, the live app rendered a white screen with:

```txt
Cannot read properties of null (reading 'toLowerCase')
```

Root cause: live Supabase/API data can contain `null` for client/contact fields even though the React types expected strings. The app then called `.toLowerCase()` / `.trim()` during initial client list memoisation, crashing the whole app before render.

Fixes applied:

- Added `safeText()` and `safeTrim()` helpers.
- Made client matching/search/header normalisation null-safe.
- Added `cleanPerson()` / `cleanPeople()` and sanitised people arrays before storing them in React state.
- Made selected-client notification recipient matching null-safe.
- Made Caddy profile URL generation null-safe.
- Confirmed `npm run build` passes.
