# Live deploy audit — 22 June 2026

## Confirmed in Netlify production

- Site: `clarity-golf-booking` / `https://claritygolf.app`
- Deploy state: `ready`
- Production deploy: `6a38389faaa634000825b148`
- Git commit: `acb37cdac0b8b2be6089afb35cc491b90aa31081`
- Netlify reports 27 deployed functions.

Critical deployed functions include:

- `auth-login`
- `auth-session`
- `auth-logout`
- `auth-forgot-password`
- `auth-reset-password`
- `calendar-state`
- `booking-core`
- `public-booking`
- `public-booking-notifications`
- `notification-history`
- `test-email`

The deployed Git blobs for `src/App.tsx`, `calendar-state.mts`, and `booking-core.mts` exactly match the production-repair bundle that was supplied.

## Remaining startup defect

The deployed frontend still starts non-embed pages in `authStatus = "checking"` and waits for `/api/auth/session` before enabling the login form. A pending session/database request can therefore leave the page permanently showing **Checking**.

## Hotfix in this bundle

- Non-embed pages start in `guest` mode.
- The login form displays immediately.
- The startup `/api/auth/session` request is temporarily disabled.
- Server-side authentication is not bypassed.
- Login, password reset, logout, cookies and protected API checks remain enabled.
- A page refresh requires signing in again until automatic session restoration is re-enabled.

## Validation

- 18/18 tests passed.
- 23/23 source Netlify functions bundled and imported.
- TypeScript passed.
- Vite production build passed.
