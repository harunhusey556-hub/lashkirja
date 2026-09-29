"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { API_VERSION } from "@/lib/app-origins";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { isServerNewer, retryConnection, useConnectivity } from "@/lib/connectivity";

type BannerKind = "offline" | "unreachable" | "version" | "restored";

const COPY: Record<BannerKind, string> = {
  offline: "Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot.",
  unreachable: "Palvelimeen ei saada yhteyttä. Näytetään viimeksi haetut tiedot.",
  version: "Uusi versio on saatavilla.",
  restored: "Yhteys palautui",
};

const RESTORED_MS = 2000;
const EXIT_MS = 180;

/** Per launch: a dismissed version notice stays dismissed until the next start. */
let versionDismissed = false;

/**
 * Offline / server unreachable / newer server version (SHELL-21).
 *
 * Overlays the top of <main> instead of sitting in the flow: it slides down
 * from under the header (220 ms, --ease-out) and <main> makes room with a
 * matching padding transition, so nothing jumps. Unreachable offers
 * "Yritä uudelleen"; recovery shows "Yhteys palautui" for 2 s. The version
 * notice is dismissible for the launch and links to Ohje ja tuki.
 */
export function ConnectivityBanner() {
  const { device, server, serverApiVersion } = useConnectivity();
  const [dismissedVersion, setDismissedVersion] = useState(versionDismissed);
  const [retrying, setRetrying] = useState(false);

  let live: BannerKind | null = null;
  if (device === "offline") live = "offline";
  else if (server === "unreachable") live = "unreachable";
  else if (IS_MOBILE_BUILD && !dismissedVersion && isServerNewer(serverApiVersion, API_VERSION)) live = "version";

  // "Yhteys palautui": the render where a connection problem clears.
  const [prevLive, setPrevLive] = useState<BannerKind | null>(live);
  // A counter, so every recovery restarts the 2 s confirmation.
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  if (live !== prevLive) {
    if ((prevLive === "offline" || prevLive === "unreachable") && live === null) setRestoredAt((n) => (n ?? 0) + 1);
    else if (live !== null) setRestoredAt(null);
    setPrevLive(live);
  }
  useEffect(() => {
    if (restoredAt === null) return;
    const timer = window.setTimeout(() => setRestoredAt(null), RESTORED_MS);
    return () => window.clearTimeout(timer);
  }, [restoredAt]);

  const kind: BannerKind | null = live ?? (restoredAt !== null ? "restored" : null);

  // Keep the last banner mounted for its exit.
  const [shown, setShown] = useState<BannerKind | null>(kind);
  const [phase, setPhase] = useState<"enter" | "open" | "exit">("enter");
  if (kind !== null) {
    if (kind !== shown) setShown(kind);
    if (shown === null) {
      if (phase !== "enter") setPhase("enter");
    } else if (phase === "exit") {
      setPhase("open");
    }
  } else if (shown !== null && phase !== "exit") {
    setPhase("exit");
  }

  useEffect(() => {
    if (phase === "enter" && shown) {
      const raf = requestAnimationFrame(() => setPhase("open"));
      return () => cancelAnimationFrame(raf);
    }
    if (phase === "exit") {
      const timer = window.setTimeout(() => {
        setShown(null);
        setPhase("enter");
      }, EXIT_MS);
      return () => window.clearTimeout(timer);
    }
  }, [phase, shown]);

  // Tell the frame how much room to make at the top of <main>. The short
  // "Yhteys palautui" confirmation only overlays.
  const ref = useRef<HTMLDivElement>(null);
  const holdsRoom = shown !== null && shown !== "restored" && phase !== "exit";
  useLayoutEffect(() => {
    const frame = ref.current?.closest<HTMLElement>(".app-frame") ?? document.querySelector<HTMLElement>(".app-frame");
    if (!frame) return;
    const height = holdsRoom ? Math.ceil(ref.current?.querySelector(".connectivity-banner")?.getBoundingClientRect().height ?? 0) : 0;
    frame.style.setProperty("--banner-h", `${height}px`);
    frame.dataset.banner = holdsRoom ? "shown" : "hidden";
  }, [holdsRoom, shown]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await retryConnection();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div ref={ref} className="relative z-[35] h-0 flex-none">
      {shown && (
        <div
          role="status"
          data-connectivity={shown === "restored" ? "success" : shown === "version" ? "info" : "warning"}
          data-state={phase}
          className="connectivity-banner flex min-h-10 items-center justify-center gap-3 border-b border-line px-4 py-1.5 text-center text-[13px] leading-snug text-ink"
        >
          <span>{COPY[shown]}</span>
          {shown === "unreachable" && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="-my-1 min-h-9 shrink-0 rounded-full border border-line bg-surface px-3 text-[13px] font-semibold text-ink disabled:opacity-60"
            >
              {retrying ? "Yritetään…" : "Yritä uudelleen"}
            </button>
          )}
          {shown === "version" && (
            <>
              <Link href="/asetukset/ohje" className="-my-1 flex min-h-9 shrink-0 items-center font-semibold text-accent">
                Lisätietoja
              </Link>
              <button
                type="button"
                aria-label="Sulje ilmoitus"
                onClick={() => {
                  versionDismissed = true;
                  setDismissedVersion(true);
                }}
                className="-my-1 -mr-2 flex h-9 w-9 shrink-0 items-center justify-center text-ink-2"
              >
                <Icon icon={X} size="inline" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
