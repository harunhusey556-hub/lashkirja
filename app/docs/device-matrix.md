# Device matrix

Unit profiles in `app/src/lib/device-matrix.ts` cover:

- compact portrait, 390×844, notch fallback 47 and home indicator 34
- large portrait, 430×932, Dynamic Island fallback 59 and home indicator 34
- compact landscape 844×390 and large landscape 932×430, with side insets
- a focused keyboard on both widths, which lifts the frame and does not become safe-area padding

`profileLayout` calls the same `usableArea` the shell uses. A content width under 280px fails the test.

These thresholds do not replace a WKWebView IPA smoke. Playwright at 390 and 430 (`tests/e2e/viewport.spec.ts`) runs in CI on Chromium and on WebKit (`mobile-webkit` in `playwright.config.ts`). Neither project applies `env(safe-area-inset-*)` the way iOS does, and neither slides the system keyboard over the visual viewport. An installed IPA still needs a pass on a notched phone, in landscape, and with the keyboard open. CI does not build or launch that IPA.
