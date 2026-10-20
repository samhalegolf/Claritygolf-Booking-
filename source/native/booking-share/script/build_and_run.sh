#!/usr/bin/env bash
set -euo pipefail
MODE="run"
if [[ $# -gt 0 ]]; then MODE="$1"; fi
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="ClarityBookingDesktop"
APP_BUNDLE="$ROOT_DIR/dist/Clarity Booking.app"
if [[ "$MODE" != "--build-only" ]]; then pkill -x "$APP_NAME" >/dev/null 2>&1 || true; fi
swift build --package-path "$ROOT_DIR" --product "$APP_NAME"
BUILD_DIR="$(swift build --package-path "$ROOT_DIR" --show-bin-path)"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cp "$BUILD_DIR/$APP_NAME" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
cat >"$APP_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ClarityBookingDesktop</string>
<key>CFBundleIdentifier</key><string>app.claritygolf.booking.desktop</string>
<key>CFBundleName</key><string>Clarity Booking</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSCameraUsageDescription</key><string>Record lesson videos in Clarity Booking.</string>
<key>NSMicrophoneUsageDescription</key><string>Record commentary for lesson videos.</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP_BUNDLE"
case "$MODE" in
  --build-only) printf '%s\n' "$APP_BUNDLE" ;;
  run) /usr/bin/open -n "$APP_BUNDLE" ;;
  --verify) /usr/bin/open -n "$APP_BUNDLE"; sleep 1; pgrep -x "$APP_NAME" >/dev/null ;;
  --debug) lldb -- "$APP_BUNDLE/Contents/MacOS/$APP_NAME" ;;
  --logs|--telemetry) /usr/bin/open -n "$APP_BUNDLE"; /usr/bin/log stream --info --style compact --predicate 'process == "ClarityBookingDesktop"' ;;
  *) echo "Usage: $0 [--build-only|--verify|--debug|--logs|--telemetry]" >&2; exit 2 ;;
esac
