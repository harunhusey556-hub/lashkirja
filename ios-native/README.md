# LashKirja native iOS app

SwiftUI app that talks to the LashKirja server API (`app/`) with a bearer token.

- `LashKirjaCore/` — platform-neutral Swift package: models, API client, auth,
  SSE, formatting. Tests run anywhere with Swift 6: `cd LashKirjaCore && swift test`.
- `App/` — the SwiftUI app. `project.yml` is an XcodeGen spec; the Xcode project
  is generated, not committed: `cd App && xcodegen generate`.

## Build

CI (`.github/workflows/ios-native.yml`) on every push to `native`:
Linux core tests → macOS simulator build + tests → unsigned IPA artifact
`LashKirja-native-unsigned-ipa`. Run it by hand from the Actions tab with
another `api_base_url` when the server moves.

On a Mac with Xcode 26: `brew install xcodegen && cd App && xcodegen generate &&
open LashKirja.xcodeproj`, set your team for signing, run on a device.

## Server

The app needs the server from this branch (`app/`), which also returns
`reviewStatus` for receipts. Deploy it with
`deploy-local.ps1 -Remote github -Ref native`.
