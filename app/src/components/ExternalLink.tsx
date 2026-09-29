"use client";

import type { ReactNode } from "react";
import { openExternal } from "@/lib/open-external";

/**
 * A real link (`href`, long-press and screen readers all work) that opens
 * outside the app through `openExternal`. 44 px tall, pressable.
 */
export function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternal(href);
      }}
      className={`active-press inline-flex min-h-11 items-center font-medium text-accent ${className}`.trim()}
    >
      {children}
    </a>
  );
}
