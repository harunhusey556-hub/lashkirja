"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { Icon } from "@/components/ds/Icon";
import { API_VERSION } from "@/lib/app-origins";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { useConnectionNoticeClaimed } from "@/lib/connection-notice";
import { isServerNewer, retryConnection, useConnectivity } from "@/lib/connectivity";
import { STALE_COPY } from "@/lib/screen-state";

type BannerKind = "offline" | "unreachable" | "version" | "restored";

const COPY: Record<BannerKind, string> = {
  offline: STALE_COPY.offline,
  unreachable: STALE_COPY.unreachable,
  version: "Uusi versio on saatavilla.",
  restored: "Yhteys palautui",
};

const RESTORED_MS = 2000;
const EXIT_MS = 180;
/** An offline or unreachable notice stays this long, then makes way for the content; a new screen shows it again. */
const LINGER_MS = 7000;

/** Per launch: a dismissed version notice stays dismissed until the next start. */
let versionDismissed = false;

/**
 * Offline / server unreachable / newer server version (SHELL-21, VS-32).
 *
 * A pure overlay: it floats over the top of <main> under the header and never
 * moves the content (no padding, no reflow). It slides down from under the
 * header (220 ms, --ease-out).
 * - Offline and unreachable say it once for 7 s and again on every new screen
 *   while the problem lasts; a page that has its own card (`ConnectionNotice`,
 *   `StaleBanner`) owns the message and the banner steps aside, so there is one
 *   message and one retry per screen (FP-14). Unreachable offers "Yritä uudelleen".
 * - Recovery shows "Yhteys palautui" for 2 s.
 * - The version notice is dismissible for the launch and links to Ohje ja tuki.
 */
export function ConnectivityBanner() {
  const { device, server, serverApiVersion } = useConnectivity();
  const pathname = usePathname();
  const claimed = useConnectionNoticeClaimed();
  const [lingered, setLingered] = useState<{ kind: BannerKind; path: string } | null>(null);
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

  // A page card owns the message, or the notice has been up long enough on this screen.
  const connectionProblem = live === "offline" || live === "unreachable";
  const quiet = connectionProblem && (claimed || (lingered?.kind === live && lingered.path === pathname));
  const kind: BannerKind | null = live ? (quiet ? null : live) : restoredAt !== null ? "restored" : null;

  useEffect(() => {
    if (kind !== "offline" && kind !== "unreachable") return;
    const timer = window.setTimeout(() => setLingered({ kind, path: pathname }), LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [kind, pathname]);

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
    <div className="relative z-[35] h-0 flex-none">
      {shown && (
        <div
          role="status"
          data-connectivity={shown === "restored" ? "success" : shown === "version" ? "info" : "warning"}
          data-state={phase}
          className="connectivity-banner flex min-h-10 items-center justify-center gap-3 rounded-card border border-line px-4 py-1.5 text-center text-caption leading-snug text-ink"
        >
          <span>{COPY[shown]}</span>
          {shown === "unreachable" && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="-my-1 min-h-9 shrink-0 rounded-full border border-line bg-surface px-3 text-caption font-semibold text-ink disabled:opacity-60"
            >
              {retrying ? "Yritetään…" : "Yritä uudelleen"}
            </button>
          )}
          {shown === "version" && (
            <>
              <Link href="/asetukset/ohje" className="-my-1 flex min-h-9 shrink-0 items-center rounded-full bg-accent-soft px-3 font-semibold text-accent">
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
