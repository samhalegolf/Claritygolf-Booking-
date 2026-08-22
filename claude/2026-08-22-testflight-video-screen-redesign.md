# TestFlight video screen redesign

**Date:** 22 Aug 2026
**Branch:** `claude/testflight-video-screen-redesign-fgxbyr`
**Scope:** the Videos tab of the Player Terminal — the screen the TestFlight
build opens when a player taps Videos. Same component on the web, so both get
it, but the phone is what it was drawn for.

## What was wrong

The library was a table wearing a phone costume: each video was a row with a
64×44 thumbnail, three lines of text and two buttons that wrapped onto a
second line on any real device. The thumbnail — the only thing a player
actually recognises a swing by — was the smallest element on the row, and the
most common action ("just look at the video") needed an explicit `Open`
button beside a permanently-disabled-or-not `Send to coach` primary.

## The redesign

The library is now a gallery, not a table.

- **The thumbnail is the row.** A responsive grid
  (`auto-fill, minmax(140px, 1fr)` — two columns on a phone) of portrait
  3:4 tiles, because that is how swings are filmed. The whole tile is one
  press target that opens the video; the `Open` button is gone.
- **Duration** stays as a badge on the tile, iOS-style, bottom right.
- **Upload progress** is a thin bar drawn over the bottom edge of the tile
  rather than text that reflows the row.
- **Under the tile: unboxed text** (Rule 01) — title and date, then one line
  of state only when there is state (sending, sent ✓ in the success colour,
  paused, failed in the error colour). A tile at rest says nothing; the
  screen's lead already covers "on this device".
- **One boxed control per tile** — `Send to coach` / `Try again` /
  `Download`, full-width at the 44px player minimum (Rule 04), and gone once
  the video is sent instead of lingering disabled.
- **Cloud shells keep their meaning**: a video that exists in Clarity Cloud
  but not on this device is the same dashed tile with the cloud glyph, in the
  same grid; tapping either the tile or the pill downloads it.
- **Errors are one line of coloured text, not a box** (Rule 09) — the video
  error, the guest-send error and the profile-load error all converted, which
  let the `.player-portal-error` box and its two `--pt-error-*` literals be
  deleted as the stylesheet's own comment asked.

No behaviour changed: same handlers, same guest identity sheet, same
no-receipt player downloads, same status vocabulary from `sendStatusLabel`.

## Housekeeping picked up on the way

- **New tokens** `--c-scrim`, `--c-scrim-soft`, `--c-on-scrim` in
  `tokens.css` for overlays drawn on video imagery. Deliberately identical in
  both schemes — a dark scrim with light text reads on any thumbnail — so
  they are not swapped in the dark blocks.
- **The hex ratchet is green again.** `uiRules.test.ts` capped literal hex
  colours at 883; the branch (and main) sat at 887, so the suite was failing
  before this work started. The redesign plus four dead `var(--muted,
  #77746d)` fallbacks in `playerProfiles.css` (the alias is always defined on
  `.app-shell`) bring the count to 880, and the baseline is lowered to match
  in the same commit, per the test's own ceremony.

## Validation

`npm run typecheck`, `npm test` (349/349 — one more passing than main),
`npm run build` and `npm run build:app` all clean.

## Files

- `source/src/modules/player-portal/PlayerPortal.tsx` — Videos tab markup
- `source/src/modules/player-portal/playerPortal.css` — grid/tile styles,
  error-box removal
- `source/src/tokens.css` — scrim tokens
- `source/src/modules/player-profiles/playerProfiles.css` — dead fallbacks
- `source/src/uiRules.test.ts` — ratchet lowered 883 → 880
