# Validation results

Validated on 21 June 2026 with Node 22 locally and Netlify target Node 24.

- `npm ci`: passed from a clean dependency install.
- `npm test`: **17/17 passed**.
- Calendar integration: existing-email merge, caddy-profile preservation, unchanged-save deduplication, reschedule, final-item cancellation, stale-write rejection and public booking.
- Email integration: client and admin requests generated for public booking, coach booking, reschedule and cancellation; unchanged autosave generated no duplicate email.
- Auth integration: forgot password, reset password, old-session revocation, login using the new password, session validation and logout.
- `npm run check:functions`: **23/23 Netlify functions bundled and imported**.
- `tsc`: passed.
- `vite build`: passed.
- Secret audit: no `.env` files or live Supabase, Resend, Google or password credentials included.
