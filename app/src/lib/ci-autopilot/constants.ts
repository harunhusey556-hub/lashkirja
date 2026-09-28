/**
 * The step server the CI simulator autopilot talks to
 * (scripts/ci/sim-step-server.ts, started by .github/workflows/ios-sim-check.yml
 * on the macOS runner). The simulator shares the runner's loopback, so the
 * app reaches it on 127.0.0.1. Only used when NEXT_PUBLIC_CI_AUTOPILOT is
 * "1": the root layout adds it to the mobile CSP's connect-src in that build
 * alone.
 */
export const CI_STEP_ORIGIN = "http://127.0.0.1:3999";
