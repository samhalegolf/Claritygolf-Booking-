# Clarity Booking Actioned Changes

Generated: 2026-06-16

## Build status

- `npm run build` passes.
- Vite production bundle was regenerated.

## Changes actioned

### 1. Auth persistence / refresh logout

- Added `credentials: "include"` to admin auth/session/login/logout/reset fetches so the session cookie is explicitly sent during session rehydration.
- Kept the app in `authStatus: "checking"` before any login redirect/render decision.
- Session check now runs before the app marks the user as guest.
- Write endpoints now return proper `401 Admin login required` instead of silently allowing unauthenticated writes.

### 2. Admin email settings saving

- Admin notification settings now track dirty state.
- Save buttons only appear after edits.
- Successful save hides the button again.
- Failed saves show an error state and a clearer Supabase/RLS/write-access warning.
- Admin settings PUT route is protected by session auth.

### 3. Blockout interaction

- Blockout creation now requires a deliberate drag.
- Simple taps no longer commit blockouts.
- Blockout commits only on release with a valid dragged area.
- Added a minimum blockout duration check and clearer feedback if the drag is too small.
- Calendar idle timer is refreshed by pointer interactions so the calendar does not jump while the user is actively using it.

### 4–5. Mobile layout / receipt overflow

- Added mobile overflow hardening for cards, receipts, notification cards, booking confirmation, selected booking cards, widget preview, sync output, and embed code.
- Added `overflow-wrap:anywhere`, `min-width:0`, and mobile one-column fallbacks for action rows and settings rows.
- Added mobile button/tap target minimums.
- Added iframe/widget mobile sizing protection.

### 6–7. Expandable settings / email confirmations

- Existing settings `details`/accordion structure has been preserved and reinforced.
- Save controls now appear only when a section has unsaved changes and hide after save.
- Email/text/template confirmation settings now share the dirty-save pattern.

### 8. Google + Apple calendar save

- Existing Google Calendar and Apple `.ics` actions were verified in the booking confirmation flow.
- Calendar details now include booking reference in both Google Calendar details and Apple `.ics` description.

### 9. Booking popup card

- Mobile overflow and wrapping protections added to selected/booking card surfaces.
- Secondary action rows collapse to full-width mobile buttons.

### 10. Group classes wiring check

- Group service fields are present and still build: lesson format, min participants, capacity, per-person pricing.
- Build passes after service model changes.
- No live Supabase/mobile Safari test could be run from this environment, so final end-to-end production verification is still required.

### 11. Widget / iframe check

- Widget iframe preview and embed output received mobile sizing/overflow protection.
- Booking confirmation calendar actions remain available in public/embed flow.
- Live external-page and cross-origin testing still needs to be done on the deployed site.

### 12. Appointment type colours

- Added `color` to appointment/service model.
- Added sensible default colours to default appointment types.
- Added colour picker to add/edit appointment type form.
- Calendar appointment cards now use the appointment type colour via `--service-colour`.
- Server-side service cleaning now preserves and validates colour.

### 13. Current day + idle reset

- Added current-day detection and subtle calendar lane highlight.
- Added 10-minute idle reset back to current week.
- Reset avoids firing while there is active pointer interaction, selected item, or quick-create popup.

## Important follow-up testing still needed

Run these on the deployed Netlify app, especially iPhone Safari:

1. Login, refresh page, confirm admin remains logged in.
2. Edit admin notification email, save, refresh, confirm persisted.
3. Try blockout: tap only, pan/scroll, then deliberate drag.
4. Public booking through widget iframe on an external page.
5. Group class booking with capacity edge cases.
6. Google Calendar button and Apple `.ics` import from a real booking confirmation.
