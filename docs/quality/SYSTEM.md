# How LashKirja work is done (the system)

Owner's request (2026-09-29): gather information first, use the best available skills and tools, find where the work is limited, set up one system, and keep working inside it until the app is complete, "even the simplest parts". Every piece of work follows this file.

## 1. Sources of truth

| File | What it holds |
|---|---|
| `docs/quality/QUALITY-BAR.md` | The definition of "done" for every screen and component. It is an iOS-app bar, not a web-page bar. |
| `docs/quality/BACKLOG.md` | Every known gap, with an ID, its source, its severity, its status and its evidence. Nothing is fixed that is not in it, and nothing in it is dropped silently. |
| `docs/quality/LIMITS.md` | Where verification is limited, and how each limit is compensated. |
| `.superpowers/sdd/<plan>/progress.md` | The execution ledger of the batch that is running. |

## 2. The loop, one batch at a time

1. **Audit.** Parallel auditors walk every screen against the QUALITY-BAR in WebKit iPhone emulation. They use the skills listed in §4, and their findings go into BACKLOG.md with screenshot evidence. The owner's own reports enter the backlog verbatim, with source `owner`.
2. **Triage.**
   - **P0:** broken or missing function, or data risk.
   - **P1:** feels unfinished, e.g. no password reveal, abrupt open/close, flicker.
   - **P2:** polish.
   
   A batch takes all open P0 items plus the owner's reports, then as many P1 items as fit.
3. **Plan.** The batch plan in `docs/superpowers/plans/` splits the work into lanes by disjoint files, so the lanes can run in parallel (see the parallel rules in `.superpowers/sdd/2026-09-28-real-app-b-bundled/parallel-rules.md`).
4. **Build.** Implementers work in parallel lanes. Each item is verified by:
   - a test, where it is logic;
   - a WebKit iPhone screenshot or video, where it is visual or interaction;
   - the iOS Simulator run in CI, where it is native: camera, keyboard, scroll physics, safe areas.
5. **One final review per batch.** Parallel reviewers split by area, followed by one fix wave.
6. **Ship.** Deploy to production with `deploy-local.ps1` (health check and automatic rollback), build the IPA in CI, and inspect it.
7. **Deliver.** Send the IPA, before/after screenshots, and the list of BACKLOG IDs closed. The owner's device feedback enters the backlog, and the next batch starts.

## 3. Rules

- The owner's words are the requirement. Before recommending something, check it against the owner's stated goal, and say plainly when an option does not meet it.
- Never ship a screen that fails the QUALITY-BAR items it touches.
- Review once per batch, not per task. The owner's usage limit matters.
- Production is only changed through `deploy-local.ps1`.

## 4. Skills and tools in use

| Need | Skill or tool |
|---|---|
| iOS look and behaviour | `ios-hig-design`, `mobile-ios-design`, `apple-design` (Emil Kowalski) |
| Motion | `improve-animations`, `review-animations`, `find-animation-opportunities`, `design-taste` (the motion reference) |
| UI rules | `web-design-guidelines` (Vercel), `ui-ux-pro-max` |
| React/Next performance | `vercel-react-best-practices` |
| Capacitor | `capacitor-best-practices`, `capacitor-react`, `capacitor-apple-review-preflight` |
| Tests | `playwright-best-practices`; Playwright **WebKit** with an iPhone profile (closest to WKWebView on Windows) |
| Native verification | an iOS Simulator run on the CI macOS runner that installs the app, drives it and records screenshots and video (see LIMITS.md) |
| Process | `subagent-driven-development` in parallel lanes, `task-observer` |
