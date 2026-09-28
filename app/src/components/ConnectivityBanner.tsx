"use client";

import { API_VERSION } from "@/lib/app-origins";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { isServerNewer, useConnectivity } from "@/lib/connectivity";

/**
 * Below the header, above page content -- rendered in normal flow so it
 * never causes the (position: fixed) tab bar to jump. `role="status"` so
 * screen readers announce it without stealing focus.
 */
export function ConnectivityBanner() {
  const { device, server, serverApiVersion } = useConnectivity();

  let message: string;
  let tone: "warning" | "info";
  if (device === "offline") {
    message = "Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot.";
    tone = "warning";
  } else if (server === "unreachable") {
    message = "Palvelimeen ei saada yhteyttä. Näytetään viimeksi haetut tiedot.";
    tone = "warning";
  } else if (IS_MOBILE_BUILD && isServerNewer(serverApiVersion, API_VERSION)) {
    message = "LashKirjasta on uudempi versio. Päivitä sovellus.";
    tone = "info";
  } else {
    return null;
  }

  return (
    <div
      role="status"
      data-connectivity={tone}
      className={`px-4 py-2 text-center text-[13px] leading-relaxed ${
        tone === "warning" ? "bg-warning/10 text-ink" : "bg-accent-soft text-ink"
      }`}
    >
      {message}
    </div>
  );
}
