"use client";

import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { openAuthedFile } from "@/lib/authed-file";
import { showToast } from "@/lib/toast";

/**
 * A link to an authenticated file (PDF, CSV, zip). On the web build it is a
 * plain `<a href>` -- the session cookie authenticates it exactly like
 * today. On the mobile build there is no cookie, so a click fetches the
 * bytes with the bearer token instead and hands them to the native share
 * sheet; the anchor's `href` stays in place (harmless, never followed) so
 * the element still reads as a link to assistive tech and to anything that
 * inspects the DOM.
 */
export function AuthedFileLink({
  href,
  fallbackName,
  title,
  className,
  children,
}: {
  href: string;
  fallbackName: string;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (!IS_MOBILE_BUILD) {
    // No target/rel here: today's per-site behaviour (a plain same-tab
    // link, letting Content-Disposition drive attachment vs. inline)
    // stays exactly as it was before this component existed.
    return (
      <a href={href} aria-label={title} className={className}>
        {children}
      </a>
    );
  }

  // A failure is a toast (SHELL-13/23), not a fixed paragraph that stays
  // until the next tap.
  return (
    <a
      href={href}
      aria-label={title}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        void openAuthedFile(href, fallbackName, title).catch(() => {
          showToast({ tone: "error", text: "Tiedosto ei ole saatavilla ilman yhteyttä." });
        });
      }}
    >
      {children}
    </a>
  );
}
