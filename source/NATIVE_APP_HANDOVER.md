# Player Portal as a native app — Handover

Built 20 Aug 2026. The portal now has a second build target that Capacitor can
wrap and run on a simulator or a device. It is not a second app: same repo,
same `src/`, same components, same API. Only the entry point and the way the
session travels are different.

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

## Known gaps

- **Web push does nothing in the app.** Service workers are unreliable in the
  Capacitor webview. The push panel is coach-only and inside `App`, so nothing
  registers `sw.js` here — but `sw.js` and `manifest.webmanifest` are still
  copied into `dist-app/` as dead files. Real push means APNs and a native
  plugin, which is its own patch.
- **Video submissions are untested on device.** The upload path takes the
  bearer token and the resumable chunk logic is unchanged, but a 750 MB upload
  from a phone over cellular has not been exercised.
- **No icon or splash screen yet.** `npx @capacitor/assets generate` from a
  1024px source is the usual route.
- **Deep links are not wired.** A password-reset or portal-invite email opens
  the browser, not the app. That needs Universal Links / App Links.
- **Nothing is signed.** Simulator only until there is a bundle ID in your
  Apple Developer account. `app.claritygolf.player` is the placeholder in
  `capacitor.config.ts`.
