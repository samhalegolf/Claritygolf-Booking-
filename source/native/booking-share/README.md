# Deferred native video sharing

This package adds a native file provider to the existing Booking web interface.

- Mac: build the ClarityBookingDesktop executable into an app bundle using `bash script/build_and_run.sh`. It opens claritygolf.app in its own persistent WebKit session.
- iPhone staff app: the Xcode project links the library directly and installs the bridge from BookingBridgeViewController. Build/sync the existing staff app normally.
- The Mac wrapper also routes video Export through NSSavePanel before preparation and writes the selected destination atomically.
- Chrome and other browsers continue to use Web Share; their APIs cannot request destination-first file generation. Installing a PWA does not add the native bridge.

## Delivery sequence

1. The original Share tap calls the native present handler with an ID and filename only.
2. macOS didChoose / iOS UIActivityItemProvider.item requests preparation after a destination is selected. Cancel before selection invokes no encoder.
3. The existing video producer runs. A nonmodal Working bar reports preparation and byte-transfer progress.
4. Ordered 256 KiB acknowledged chunks create a private temporary file. Native rejects reordered chunks, unsupported types, incomplete sizes and files above 2 GiB.
5. The selected system service receives the finished file. Completion means handover; it does not assert that another app completed its own upload.

The bridge is only available to the main frame at https://claritygolf.app or capacitor://localhost. It never fetches URLs, accepts filesystem paths, or exposes session cookies. Window reload and cancellation release pending providers. Sessions time out after 15 minutes. Completed files remain for five minutes to allow receiving apps to copy them; failures remove partial files.

## Build and checks

```sh
swift test
bash script/build_and_run.sh --build-only
```

The Native video sharing GitHub Actions workflow checks macOS tests/builds, iOS bridge typechecking, web tests and TypeScript. It uploads a Clarity-Booking-Mac app artifact. The desktop bundle is ad-hoc signed for development; it is not a notarised distribution build. The native bridge requires the matching web change to be deployed.

## Interactive acceptance checks

- Open an actual local and cloud-only clip, then click Share. Confirm native choices appear before encoding/download.
- Dismiss the chooser and verify no video is prepared.
- Select AirDrop, Mail or a receiving extension. Verify a valid playable video arrives, including annotations/comparison where applicable.
- Cancel while working; retry; close/reload the host while working; simulate an encoder or storage failure.
- On iPad confirm popover anchoring. Test actual third-party video extensions: availability and provider support belong to the receiving app.
- Confirm ordinary Chrome use still has the existing fallback and Export still asks for a location where supported.

The Mac host is intentionally small. Existing external popup/OAuth flows open the system browser, and do not inherit its cookies. Validate the staff login and any external integrations before treating it as a replacement for all browser features.
