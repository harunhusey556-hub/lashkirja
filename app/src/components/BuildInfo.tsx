"use client";

import { useEffect, useState } from "react";
import { version as appVersion } from "../../package.json";

/**
 * What this running web build is, plus the native shell version when the
 * page is inside Capacitor. The IPA bakes its server URL at sync time, so a
 * new web commit does not change an already installed app.
 */
export function BuildInfo() {
  const [native, setNative] = useState<string | null>(null);
  const envName = process.env.NEXT_PUBLIC_APP_ENV === "production" ? "tuotanto" : "kehitys";
  const commit = process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return;
        const { App } = await import("@capacitor/app");
        const info = await App.getInfo();
        if (!cancelled) setNative(`${info.version} (${info.build})`);
      } catch {
        // Browser, or an IPA built before the App plugin was added.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-1 pb-2 text-center text-xs text-ink-2">
      <p>LashKirja {appVersion}</p>
      <p>
        Verkko {commit} · {envName}
      </p>
      <p>{native ? `Sovellus ${native}` : "Selain"}</p>
      {envName === "kehitys" && (
        <p className="mx-auto max-w-sm leading-relaxed">
          Yhteys on kehityspalvelimeen. Nextin punainen Issue-merkki kuuluu next dev
          -tilaan, eikä sitä piiloteta. Asennettu IPA ei vaihda osoitetta itse:
          tuotantoon tarvitaan uusi build, jonka osoitteessa ajetaan next start.
        </p>
      )}
    </div>
  );
}
