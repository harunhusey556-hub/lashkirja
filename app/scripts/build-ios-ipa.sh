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

# Capacitor 8 uses Swift Package Manager, so there is no CocoaPods .xcworkspace.
# Build the project directly; fall back to a workspace only if one really exists.
if [[ -d "$ROOT/ios/App/App.xcworkspace" ]]; then
  PROJECT_ARGS=(-workspace "$ROOT/ios/App/App.xcworkspace")
else
  PROJECT_ARGS=(-project "$ROOT/ios/App/App.xcodeproj")
fi

SIGN_ARGS=(-allowProvisioningUpdates)
if [[ -n "${DEVELOPMENT_TEAM:-}" ]]; then
  SIGN_ARGS+=("DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM")
else
  echo "DEVELOPMENT_TEAM is not set; Xcode will only sign if the scheme already has a team."
  echo "Find it with: Xcode > Settings > Accounts > Manage Certificates, or open the project once."
fi

echo "Syncing Capacitor iOS project..."
npx cap sync ios

echo "Archiving $SCHEME ($CONFIGURATION)..."
xcodebuild \
  "${PROJECT_ARGS[@]}" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -archivePath "$ARCHIVE_PATH" \
  "${SIGN_ARGS[@]}" \
  archive

mkdir -p "$EXPORT_PATH"

echo "Exporting IPA..."
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

echo "IPA ready:"
find "$EXPORT_PATH" -name '*.ipa' -print
