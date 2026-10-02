import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";

/**
 * `copy` adds a "Kopioi" button after the value for identifiers (viite, Y-tunnus, IBAN; AX-07, R25).
 */
export function KeyValueList({ rows }: { rows: { label: string; value: ReactNode; copy?: { text: string; what: string } }[] }) {
  return (
    <dl className="ui-card shrink-0 overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
      {rows.map((row) => (
        // Label and value share a line while they fit; at a large text size the
        // value wraps under the label, right-aligned (AX-02). Values are
        // selectable, so an IBAN or a reference can be copied (AX-07, R25).
        <div key={row.label} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 px-4 py-3 text-body">
          <dt className="text-ink-2">{row.label}</dt>
          <dd className="ml-auto min-w-0 select-text text-right font-medium text-ink [overflow-wrap:anywhere]">
            {row.copy ? (
              <span className="flex items-center justify-end gap-3">
                <span className="min-w-0">{row.value}</span>
                <CopyButton text={row.copy.text} what={row.copy.what} />
              </span>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
