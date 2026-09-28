#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "IPA builds require macOS with Xcode installed."
  echo "Run this script on a Mac, or use GitHub Actions with a macOS runner."
  exit 1
fi

if [[ -z "${API_BASE_URL:-}" ]]; then
  echo "Set API_BASE_URL to your deployed HTTPS API base URL."
  echo "Example: export API_BASE_URL=https://lashkirja.example.com"
  exit 1
fi

SCHEME="${IOS_SCHEME:-App}"
CONFIGURATION="${IOS_CONFIGURATION:-Release}"
ARCHIVE_PATH="${ARCHIVE_PATH:-$ROOT/build/ios/App.xcarchive}"
EXPORT_PATH="${EXPORT_PATH:-$ROOT/build/ios/export}"
EXPORT_OPTIONS="${EXPORT_OPTIONS:-$ROOT/ios/ExportOptions.plist}"

echo "The UI ships inside the IPA now. API_BASE_URL is baked into the export at build time; it is not a WebView server URL."
echo "Native plugin or scroll changes, and any UI change, need a new IPA. A web commit alone does not update an installed app."
echo "Building the mobile static export..."
npm run build:mobile -- --api-base-url "$API_BASE_URL"
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
