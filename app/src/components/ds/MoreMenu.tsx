"use client";

import { useId, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";
import BottomSheet from "@/components/BottomSheet";
import { Icon } from "./Icon";

export function MoreMenu({ items, label = "Lisää toimintoja" }: {
  items: { label: string; onSelect: () => void; tone?: "danger"; disabled?: boolean }[]; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        // pointer-events-auto: opts back in when this trigger sits inside a `ListRow`'s `trailing`
        // slot (pointer-events-none by default - see ListRow.tsx) - without it the button is visible
        // but never receives a click/tap.
        className="active-press pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink"
      >
        <Icon icon={Ellipsis} strokeWidth={2.25} />
      </button>
      <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="Toiminnot" labelledBy={titleId} heightClass="max-h-[70dvh]">
        <div className="px-4 py-2 sheet-safe-bottom">
          <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  // The sheet stays mounted for its exit animation, so a dialog opened by
                  // onSelect would remember THIS row as the control to return focus to,
                  // and the row is gone by then. Hand focus back to the trigger first.
                  triggerRef.current?.focus({ preventScroll: true });
                  item.onSelect();
                }}
                className={`active-press flex min-h-12 w-full items-center px-4 text-left text-body disabled:opacity-50 ${
                  item.tone === "danger" ? "text-danger" : "text-ink"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
