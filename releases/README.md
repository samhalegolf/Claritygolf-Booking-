# releases/

Where the Android bundles land. Nothing in here is tracked except this file.

```
releases/
  player/   clarity-player-<version>-<build>.aab    the Player app   (built from source/)
  staff/    clarity-booking-<version>-<build>.aab   the staff app    (built from source/booking-app/)
```

Build one with `npm run native:release:aab` in the app's folder (or
`native:release:apk` for a sideloadable APK). The script runs Gradle, then
copies the bundle here under its own name, so a staff build can never be
picked up as a Player one and an older build is never silently overwritten.

- **version** is the app's package.json `version`. Bump it there.
- **build** is the git commit count at the time of the build, the same number
  Xcode stamps as CFBundleVersion. Play and App Store Connect both need it to
  go up on every upload, and refuse a repeat. Two builds of the same commit
  share a number, so the script refuses to overwrite a file that already
  exists: commit first, or `BUILD_NUMBER=<n> npm run native:release:aab`.
- **-unsigned** in the name means there was no upload key when it was built.
  Good for checking the build, refused by Play. Copy
  `android/keystore.properties.example` to `android/keystore.properties` in
  that app and fill it in.

iPhone builds do not come here. `npm run native:ios` in the app's folder
refreshes the same version numbers and opens Xcode; Product > Archive, and the
archive shows in Organizer as "Clarity Player" or "Clarity Booking".
