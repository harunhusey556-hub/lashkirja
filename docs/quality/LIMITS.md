# Where verification is limited, and the compensation

| Limit | Effect | Compensation |
|---|---|---|
| No Mac and no iPhone on this machine | Real WKWebView behaviour cannot be seen locally: rubber-band and momentum scroll, keyboard, safe areas, the camera, haptics, native sheets. | 1) Playwright **WebKit** with an iPhone 390×844 profile for rendering and interaction. 2) The **iOS Simulator in CI** (`ios-sim-check.yml`): it builds the simulator app, runs a local API server with the demo seed on the runner, logs in, walks the routes, scrolls, and records screenshots and video as artifacts. 3) The owner's device check at the end of each batch. |
| Chrome-only tests missed iOS issues | Every earlier batch was verified in Chromium. | All UI verification now uses WebKit first and Chromium second. |
| Demo login rate limit (5 per 15 min, shared by login and token) | The e2e suites starve. | Seed the persisted auth state, and add a dedicated e2e account whose rate limit is raised only in the test environment. |
| Production is the owner's live data | Nothing can be tested there. | Test on dev (:3200) and on the CI simulator server; production gets read-only probes only. |
| The unsigned IPA is installed by the owner through sideloading | Delivery is slow, and push notifications and universal links are unavailable. | Roadmap phase 3: a signed TestFlight build from CI. |
| The public Funnel relay is slow (8–11 s) when the phone has no Tailscale | Pages load slowly. | The UI is bundled in the IPA and the cache is persistent. Tailscale on the phone is recommended. |
