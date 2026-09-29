import type { ReactNode } from "react";

/**
 * An inline disclosure (search, filters, secondary details) that opens and
 * closes with height and opacity over 200 ms (C2, IA-23) instead of popping.
 * The content stays mounted; while closed it is inert (not focusable, not
 * read by VoiceOver). Pair the trigger's chevron with the same `open`.
 */
export function Disclosure({ open, children, className = "" }: { open: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={`disclosure ${className}`} data-open={open ? "true" : "false"} inert={!open}>
      <div className="disclosure-inner">{children}</div>
    </div>
  );
}
