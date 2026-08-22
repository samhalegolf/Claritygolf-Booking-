# Player Portal as a native app — Handover

Built 20 Aug 2026, revised 22 Aug 2026. The portal now has a second build
target that Capacitor can wrap and run on a simulator or a device. It is not a
second app: same repo, same `src/`, same components, same API. Only the entry
point and the way the session travels are different.

## Run it

```bash
npm install                 # picks up @capacitor/*
npx cap add ios             # once — creates ios/, commit it
npm run ios                 # build:app + cap sync ios + open Xcode
```

Then pick a simulator in Xcode and press run. `npm run android` is the same
for Android once you have `npx cap add android`.

`npm run build:app` on its own writes `dist-app/`. The web build is untouched:
`npm run build` still writes `dist/` and Netlify still deploys that.

## The two doors

| | Web | App |
| --- | --- | --- |
| HTML | `index.html` | `app/index.html` |
| Entry | `src/main.tsx` | `src/main.app.tsx` |
| Vite config | `vite.config.ts` | `vite.app.config.ts` |
| Output | `dist/` | `dist-app/` |

`src/main.tsx` routes on the session role — coach to the workspace, player to
the portal. `src/main.app.tsx` only ever opens the portal, so the phone build
never has the coach workspace as its home screen. A coach who signs in on the
phone is told plainly that this is the wrong app rather than shown an empty
portal.

The coach workspace is still *in* the app bundle, as the lazy chunk the
portal's Book panel loads — the booking widget is `App`, and the portal renders
it rather than keeping a player-shaped copy. It is ~800 KB of the download and
nothing loads it until the player taps Book.

### Which build am I? — `__CLARITY_NATIVE__`

Both vite configs `define` it: `true` in `vite.app.config.ts`, `false` in
`vite.config.ts`. `apiFetch.ts` exports it as `NATIVE`, and that is the only
thing in the codebase that knows which build it is in.

It is a bare define and not a `VITE_` env var, and the difference is not
cosmetic. Vite hoists `import.meta.env` into one runtime object, so reading a
field off it leaves a live comparison and every `if (NATIVE)` survives
minification as a branch that can never be taken. This file read
`VITE_NATIVE` through a local alias until 22 Aug 2026, and the web bundle
shipped the whole bearer-token path, the `clarity-player-token` storage key and
an 8.5 KB Capacitor core chunk as unreachable code. Not a vulnerability — the
flag was provably `false` in a browser — but not the guarantee the code claimed
either. A define substitutes at each use site as a literal, so the bundler
drops the dead side outright.

Two consequences worth knowing:

- **A new vite config must define it.** Miss it and `typeof
  __CLARITY_NATIVE__ !== "undefined"` is false, the build silently behaves as
  the web build, and a native build would send cookies that cannot travel.
- **Check the output, not the source.** `grep -c 'X-Clarity-Client'
  dist/assets/*.js` should find nothing. That the source *looks* tree-shakeable
  is what went wrong the first time.

## In a webview the URL tells you nothing

The app is served from `capacitor://localhost` with no path and no query
string. Anything that decides what to render by reading `window.location` is
therefore wrong in the app, and usually wrong in a way that fails quietly.

This bit once already. `App` decided whether it was the booking widget or the
coach workspace with `isBookingEmbedMode()`, which looks for
`?embed=booking` or the `book.claritygolf.app` hostname. Once the portal
started rendering the widget inline in its Lessons tab instead of navigating to
that URL, neither was ever true — so every `if (isEmbedMode) return` guard in
`App` stopped guarding and the coach boot sequence ran inside the player's
portal. On the web it merely fired coach requests nobody wanted; in the app it
put an error toast on the player's screen.

`App` now takes how it was mounted from its `bookingEntry` prop and only
consults the URL as a fallback. The rule to keep: **mode comes from the caller,
never from the address bar.**

## The session had to change transport

This is the part worth understanding, because everything else is config.

The portal's session is an HttpOnly `SameSite=Lax` cookie. In a webview the
page is served from `capacitor://localhost`, so every call to claritygolf.app
is cross-site and that cookie is never sent. Login would appear to succeed and
the very next request would come back as a guest, forever. No cookie posture
fixes this without loosening the browser too.

So the app carries the same `player_sessions` token in an `Authorization:
Bearer` header instead. Same token, same table, same 30-day expiry, same
immediate revocation check — only the transport differs.

| Concern | File |
| --- | --- |
| API base, bearer header, token storage | `src/modules/auth/apiFetch.ts` |
| Sign in, sign out, token lifecycle | `src/modules/auth/session.ts` |
| Bearer + CORS on the API | `netlify/functions/booking-core.mts` |
| Same, for video uploads | `netlify/functions/video-transfer.mts` |

Three things make that safe rather than merely working:

- The token is only ever *returned* to a client that sent `X-Clarity-Client:
  app`. A browser never sends it and so never sees a token; it gets the cookie
  exactly as before.
- Cross-origin requests are allowed only from the three Capacitor schemes, and
  are never credentialed — a cookie is not in play, so a hostile page on one of
  those origins gains nothing.
- The coach session was deliberately left cookie-only. There is no bearer path
  into the admin API.

Every call site now goes through `apiFetch()`, which is also where the absolute
API origin lives. Override it for a deploy preview:

```bash
VITE_API_BASE=https://deploy-preview-12--clarity.netlify.app npm run build:app
```

## Videos on a device that has never held them

A phone is a fresh device: the portal's video library is IndexedDB, so a player
signing in on the app sees an empty list however much they have in the cloud.
The Videos tab now asks `/api/video-transfer/imports` on mount and renders
anything missing as a dashed shell with a download arrow.

Two things about that path are deliberate:

- **A player download sends no import receipt.** The receipt is a coach taking
  custody — it flips the transfer to complete and schedules the Drive original
  for deletion. `importSavedVideoFromClarityCloud` takes `sendReceipt: false`
  for this reason. A player pulling a copy is a read.
- **A guest never asks at all.** A guest can put bytes into the coach's Drive
  and can never read one back out, so the portal does not call the route on
  their behalf.

**Record a video** opens the OS sheet — Photo Library, Take Video, Choose File
— rather than the in-page recorder. The `.click()` on the hidden file input has
to happen inside the tap that triggered it or iOS ignores it, which is why the
input lives in `PlayerPortal` and not in the workspace it opens. Desktop web
still gets the in-page recorder, since a file dialog there has no camera in it.

## Known gaps

- **Web push does nothing in the app.** Service workers are unreliable in the
  Capacitor webview. The push panel is coach-only and inside `App`, so nothing
  registers `sw.js` here — but `sw.js` and `manifest.webmanifest` are still
  copied into `dist-app/` as dead files. Real push means APNs and a native
  plugin, which is its own patch.
- **Video submissions are untested on device.** The upload path takes the
  bearer token and the resumable chunk logic is unchanged, but a 750 MB upload
  from a phone over cellular has not been exercised. The download direction
  above is untested on device too.
- **A cleaned-up transfer disappears from the player's list.** Once a coach
  imports a video, its Drive copy is scheduled for deletion seven days later.
  The portal filters the catalogue to transfers that are still `ready` with a
  live `driveVideoFileId`, so those rows vanish rather than offering a download
  that would 404 — but nobody has decided whether a player *should* lose access
  at that point. Worth a product answer, not just a filter.
- **No icon or splash screen yet.** `npx @capacitor/assets generate` from a
  1024px source is the usual route.
- **Deep links are not wired.** A password-reset or portal-invite email opens
  the browser, not the app. That needs Universal Links / App Links.
- **Nothing is signed.** Simulator only until there is a bundle ID in your
  Apple Developer account. `app.claritygolf.player` is the placeholder in
  `capacitor.config.ts`.
