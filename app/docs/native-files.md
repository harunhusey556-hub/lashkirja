# Native files and permissions

Web tests cover the decisions. A real camera deny, the iOS Files destination, and a share sheet still need an IPA.

- **Cancel.** An empty file picker is ignored. Nothing is uploaded. `filePickDecision(0)` is `ignore`.
- **Camera deny.** The web file input looks like a cancel. A plugin error that says the permission was denied uses `CAMERA_DENIED_MESSAGE` and does not upload. `isPermissionDenied` recognises that error.
- **Save to Files.** The PDF path writes a cache file and opens the share sheet (`shareWithCapacitor`). Files is a destination in that sheet. A dismissed sheet is `cancelled` and is not reported as a download.
- **PDF share.** Success means the file URI was attached. A missing URI is not a successful share. On the web, a required file downloads instead of sharing a URL alone.
- **External return.** An app path (`/bank/callback`, `/asetukset`) stays in the webview. `https://` leaves the app. Bank return copy is in `app/docs/bank-return.md`. The current IPA has no custom URL scheme, so a link that opens a closed app still needs a new build.
