#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "IPA builds require macOS with Xcode installed."
  echo "Run this script on a Mac, or use GitHub Actions with a macOS runner."
  exit 1
fi

if [[ -z "${CAPACITOR_SERVER_URL:-}" ]]; then
  echo "Set CAPACITOR_SERVER_URL to your deployed HTTPS app URL."
  echo "Example: export CAPACITOR_SERVER_URL=https://lashkirja.example.com"
  exit 1
fi

SCHEME="${IOS_SCHEME:-App}"
CONFIGURATION="${IOS_CONFIGURATION:-Release}"
ARCHIVE_PATH="${ARCHIVE_PATH:-$ROOT/build/ios/App.xcarchive}"
EXPORT_PATH="${EXPORT_PATH:-$ROOT/build/ios/export}"
EXPORT_OPTIONS="${EXPORT_OPTIONS:-$ROOT/ios/ExportOptions.plist}"

echo "The URL is baked into the IPA. Point it at a host running next build && next start."
echo "next dev shows a red Issue badge and is not a production target."
echo "Native plugin or scroll changes need a new IPA. A web commit alone does not update an installed app."
echo "Syncing Capacitor iOS project..."
npx cap sync ios
npx tsx scripts/patch-ios-url-scheme.ts

# Capacitor SPM ships ios/App/App.xcodeproj. App.xcworkspace exists only after CocoaPods.
echo "Archiving $SCHEME ($CONFIGURATION)..."
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -archivePath "$ARCHIVE_PATH" \
  archive

mkdir -p "$EXPORT_PATH"

echo "Exporting IPA..."
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS"

echo "IPA ready:"
find "$EXPORT_PATH" -name '*.ipa' -print
