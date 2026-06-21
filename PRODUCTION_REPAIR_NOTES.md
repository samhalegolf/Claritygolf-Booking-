# Production reliability repair — 21 June 2026

This repair treats the repository root as the only deployable source.

## Root causes fixed

- Calendar autosave recreated people by a new ID while email was uniquely indexed, causing PostgreSQL `23505` / Supabase `409` errors.
- A full calendar replacement with zero items did not delete the final appointment, so cancellation appeared to do nothing.
- Save responses wrote the returned item snapshot back into React state, retriggering autosave.
- Rapid saves could race with stale `updatedAt` values and overwrite newer public bookings.
- Login rebuilt the stored admin password from the environment on every login, undoing password resets.
- Logout, forgot-password, reset-password, and public booking notification routes did not have stable dedicated functions.
- The selected-client suggestion flow had no durable selected-client state, so a different fuzzy match could reappear.
- Direct admin calendar saves bypassed booking/reschedule/cancellation email delivery.

## Repair behavior

- People are resolved by normalized email, with the existing person ID/profile winning.
- Calendar saves are serialized in the browser and protected by optimistic concurrency on the server.
- Mobile/interrupted responses are verified against live state before showing a database failure.
- Empty full replacements persist, including cancellation of the final lesson.
- Login verifies the stored password hash; reset creates a new valid session and logout clears it.
- Admin calendar email work is queued to a signed Netlify Background Function after the database save.
- Public booking storage remains successful even if optional contact syncing temporarily fails.
- A selected quick-booking client remains selected until the coach manually changes identifying fields.

## Verification

`npm run build` runs:

1. canonical-root verification,
2. deterministic frontend reliability patching,
3. 20 reliability/integration tests,
4. bundling checks for every Netlify function,
5. TypeScript and Vite production build.
