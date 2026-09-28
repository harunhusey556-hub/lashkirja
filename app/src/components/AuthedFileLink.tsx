"use client";

import { useState } from "react";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { openAuthedFile } from "@/lib/authed-file";

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
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <a
        href={href}
        aria-label={title}
        className={className}
        onClick={(event) => {
          event.preventDefault();
          setError(null);
          void openAuthedFile(href, fallbackName, title).catch(() => {
            setError("Tiedosto ei ole saatavilla ilman yhteyttä.");
          });
        }}
      >
        {children}
      </a>
      {error && (
        <p
          role="alert"
          className="fixed inset-x-4 z-50 rounded-card bg-danger px-4 py-3 text-center text-sm text-canvas"
          style={{ bottom: "max(1rem, var(--safe-bottom))" }}
        >
          {error}
        </p>
      )}
    </>
  );
}
