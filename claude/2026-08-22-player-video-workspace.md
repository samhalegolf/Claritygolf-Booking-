# The player's video workspace — same logic, applied to the screen itself

**Date:** 22 Aug 2026
**Branch:** `claude/testflight-video-screen-redesign-fgxbyr`
**Scope:** the video analysis workspace as a player sees it (`variant="player"`).
The coach console is deliberately untouched.

Follow-on to the Videos *library* redesign (PR #98). That one fixed the screen
that lists swings; this one fixes the screen you open one on.

## What was wrong

The player was being shown the coach's console. Counted on a phone: a title, a
subtitle, a sticky toolbar of **twelve** icon buttons (back, clear, undo,
single, compare, linked, sync, five tools, focus), a save group of two more, a
per-video header with a status chip and **four** more buttons (record, play,
replace, clear), a timeline carrying its own title and a zoom slider, and an
always-empty focus-snapshot strip underneath. Around twenty controls
surrounding one picture, in a page that scrolled — so the transport controls
and the video were rarely on screen together.

And the one gesture the screen is actually for — moving through the swing a
frame at a time — did not exist. The only way to move was the timeline, which
on a phone spends about 350 pixels on the whole clip: a thumb lands within
roughly a tenth of a second of where it was aimed. Fine for finding the swing,
useless for looking at impact.

## The redesign

**Touch the video to move through it.** A horizontal drag on the picture
scrubs frame by frame — one frame per 7px, so a full-width swipe covers about
two seconds and a single frame is a deliberate, reachable movement. Dragging
starts by pausing, because scrubbing a playing video fights the clock. A tap
plays or pauses. A vertical drag is left alone: it belongs to the page, and
claiming it would break scrolling wherever the workspace is embedded.

**The tool rail is tucked away.** One pencil toggle slides a rail of the five
drawing tools (plus undo and clear) in over the left edge of the video. It
overlays rather than occupying a column, so opening it never resizes the
video, and it stays mounted while closed so the selected tool survives being
put away. The rail is also the mode switch: closed, a drag scrubs; open, a
drag draws. One flag, because a player who has put the tools away has already
said which of the two they meant.

**Nothing below the fold.** The screen is locked to the viewport — the portal's
video host is now an exact height (`100dvh` minus the nav) with `overflow:
hidden`, and the workspace lays itself out inside it: video, timeline, one row
of controls. Verified at 390×844, 320×568 and landscape 844×390, with both
portrait and landscape clips: zero page overflow in all four, control row
fully visible in all four.

**One row of controls instead of twenty.** `[tools] [◀frame] [play] [frame▶]`
on the left, `Save` and `Send to coach` on the right, and the save state as one
line of text under it. Everything else is gone from the player's screen:

| Dropped | Why |
| --- | --- |
| Title + subtitle | The terminal's own bar says Videos and offers the way back |
| Back button | Same — the portal already renders one |
| Single / Compare / Linked / Sync | Comparison is a coach workflow |
| Focus palette + snapshot strip | Coach tools; the strip was a permanently empty panel |
| Video header chip + record/replace/clear | Choosing a clip is what the screen they arrived from is for |
| Timeline title + zoom slider | Console furniture above a bar the thumb was already on |
| Diagnostics, screen record, My Library | Already coach-only |

**Boxes only where you can press** (Rule 01). The video was a bordered padded
card wrapping a second bordered shell wrapping the picture; now the picture is
its own edge, and the dark surround moved to the screen it sits on — the
workspace is never light, and that has to survive the card losing its
background. The rail's separator is a hairline, not a second container. Save
state is a coloured line, not a box.

## Two bugs found while testing this

Both were pre-existing on `main` and both are fixed here, because the feature
above cannot be right while either stands.

**The timeline playhead never moved.** `usePlayback` attaches its `timeupdate`
listeners in an effect keyed only on the ref object. The workspace renders no
`<video>` until a clip is chosen, and a ref filling in later is not a state
change — so the effect ran once against `null` and never again. Everything
downstream of `currentTime` sat at zero for the life of the screen: the
playhead stayed pinned at 0%, and a frame step or a scrub measured its move
from 0 rather than from where the video actually was. Reading `videoRef.current`
during render makes the element's arrival a dependency the effect can see.
Confirmed before (`playhead: 0%` at 1.2s of playback) and after
(`playhead: 72.8%`).

**A swipe could start the video playing.** A gesture that never engaged the
scrubber was released as a tap, so a vertical scroll across the picture read as
"play". Vertical travel now marks the gesture as moved, which is what stops it
being a tap.

## Validation

Driven in a real browser (Playwright + Chromium) against a generated clip, at
phone viewports. All seven behaviours verified:

| Check | Result |
| --- | --- |
| Tap → play | ✅ |
| Tap again → pause | ✅ |
| Drag +70px | ✅ exactly +0.333s (+10 frames at 30fps), stays paused |
| Drag −40px | ✅ −0.2s (−6 frames) |
| Vertical drag | ✅ no seek, no play |
| Rail opens over the video | ✅ |
| Rail open → drag draws, does not scrub | ✅ |

Coach console re-checked in the same harness and unchanged: title, 12 toolbar
buttons, card header with 4 actions, both save buttons, zoom slider, focus
strip, no player bar, no rail.

`npm run typecheck`, `npm test` (349/349), `npm run build` and
`npm run build:app` all clean.

## Files

- `source/src/modules/video-analysis/components/PlayerVideoControls.tsx` — new: the rail and the action bar
- `source/src/modules/video-analysis/VideoWorkspace.tsx` — scrub gesture, player chrome gating
- `source/src/modules/video-analysis/theme/videoAnalysis.css` — the player block
- `source/src/modules/video-analysis/components/Timeline.tsx` — `showHeader` prop
- `source/src/modules/video-analysis/hooks/usePlayback.ts` — listener attachment fix
- `source/src/modules/player-portal/playerPortal.css` — viewport lock, dark surround

## Worth a product answer

Record / Replace / Clear are gone from the player's workspace. Re-recording is
now Back → Record on the Videos screen, one extra tap for a rare action. If
that turns out to be wrong, the cheapest fix is a single overflow control on
the action bar rather than restoring the header row.
