"use client";

import { useEffect } from "react";

/**
 * Starts the CI simulator autopilot (src/lib/ci-autopilot/run.ts) once per
 * app launch. `process.env.NEXT_PUBLIC_CI_AUTOPILOT` is always inlined as a
 * literal "0" or "1" (next.config.ts), so in every normal build the guard
 * below is `"0" === "1"` and the dynamic import -- the only reference to the
 * autopilot module -- is dropped as dead code. The guard must stay inline
 * here, not behind an imported constant, so that folding cannot depend on
 * cross-module optimisation.
 */
export function CiAutopilot() {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_CI_AUTOPILOT === "1") {
      void import("@/lib/ci-autopilot/run").then((autopilot) => autopilot.startCiAutopilot());
    }
  }, []);
  return null;
}
