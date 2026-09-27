# Native files and permissions

Web tests cover the decisions. A real camera deny, the iOS Files destination, and a share sheet still need an IPA.

## When the system asks

The browser keeps a normal file input. In the iOS shell, the button calls the native plugin on that tap:

| Button | Plugin | System prompt |
| --- | --- | --- |
| Ota kuva | `@capacitor/camera` `requestPermissions` + `takePhoto` | Camera (`NSCameraUsageDescription`) |
| Valitse kuvista | `@capacitor/camera` `requestPermissions` for photos, then the gallery | Photo library, including the limited-library choice (`NSPhotoLibraryUsageDescription`) |
| Valitse tiedosto / Tuo tiedosto | `@capawesome/capacitor-file-picker` | iOS document picker (Files). Apple does not use a usage-description string for this picker. |
| Face ID | `@aparajita/capacitor-biometric-auth` | Face ID (`NSFaceIDUsageDescription`), when the user turns the lock on |

`granted` and `limited` both continue into the picker. A deny stays on the screen with Finnish copy and does not upload. Cancel stays quiet.

These plugins and the Finnish strings in `ios/App/App/Info.plist` are in the app only after the next IPA rebuild. An already installed IPA still uses whatever strings and plugins that binary was built with. Rebuild with `build-ipa.yml` (it runs `cap sync`, which links Camera and File Picker).

- **Cancel.** An empty file picker is ignored. Nothing is uploaded. `filePickDecision(0)` is `ignore`.
- **Camera deny.** The web file input looks like a cancel. A plugin error that says the permission was denied uses `CAMERA_DENIED_MESSAGE` and does not upload. `isPermissionDenied` recognises that error.
- **Save to Files.** The PDF path writes a cache file and opens the share sheet (`shareWithCapacitor`). Files is a destination in that sheet. A dismissed sheet is `cancelled` and is not reported as a download.
- **PDF share.** Success means the file URI was attached. A missing URI is not a successful share. On the web, a required file downloads instead of sharing a URL alone.
- **External return.** An app path (`/bank/callback`, `/asetukset`) stays in the webview. `https://` leaves the app. Bank return copy is in `app/docs/bank-return.md`. The web handler accepts `lashkirja://bank/callback`. The next IPA build registers that scheme. An already installed IPA does not, until it is rebuilt.
- **Offline and share plugins.** `errorPath` is `offline.html` when `CAPACITOR_SERVER_URL` is set. Filesystem and Share are installed packages; `cap sync` includes them in the next IPA. PDF share still writes a cache file and attaches that URI.
