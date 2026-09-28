"use client";

import { useEffect, useState } from "react";
import { version as appVersion } from "../../package.json";
import { API_BASE_URL, IS_MOBILE_BUILD } from "@/lib/build-target";
import { isPageCachePersistent } from "@/lib/page-cache";

function apiHost(): string {
  try {
    return new URL(API_BASE_URL).host;
  } catch {
    return API_BASE_URL || "tuntematon";
  }
}

/**
 * What this running web build is, plus the native shell version when the
 * page is inside Capacitor. The IPA bakes its server URL at sync time, so a
 * new web commit does not change an already installed app.
 *
 * Mobile only (Task 8): "Sovellus: paketoitu" (the UI is bundled in the
 * IPA, not fetched from the server), the API host it talks to, and
 * whether the persistent cache is actually backed by IndexedDB or fell
 * back to memory-only (Task 7's `openPersistentCache` returning null) --
 * the owner reads this line on the device (Task 13).
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
      {IS_MOBILE_BUILD ? (
        <>
          <p>Sovellus: paketoitu</p>
          <p>Palvelin: {apiHost()}</p>
          <p>Välimuisti: {isPageCachePersistent() ? "salattu" : "vain muistissa"}</p>
        </>
      ) : (
        <>
          <p>
            Verkko {commit} · {envName}
          </p>
          <p>{native ? `Sovellus ${native}` : "Selain"}</p>
        </>
      )}
      {!IS_MOBILE_BUILD && envName === "kehitys" && (
        <p className="mx-auto max-w-sm leading-relaxed">
          Yhteys on kehityspalvelimeen. Nextin punainen Issue-merkki kuuluu next dev
          -tilaan, eikä sitä piiloteta. Asennettu IPA ei vaihda osoitetta itse:
          tuotantoon tarvitaan uusi build, jonka osoitteessa ajetaan next start.
        </p>
      )}
    </div>
  );
}
