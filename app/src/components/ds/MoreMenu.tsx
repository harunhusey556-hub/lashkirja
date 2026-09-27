"use client";

import { useId, useState } from "react";
import BottomSheet from "@/components/BottomSheet";

export function MoreMenu({ items, label = "Lisää toimintoja" }: {
  items: { label: string; onSelect: () => void; tone?: "danger"; disabled?: boolean }[]; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="active-press flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="Toiminnot" labelledBy={titleId} heightClass="max-h-[70dvh]">
        <div className="px-3 py-2 sheet-safe-bottom">
          <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={`active-press flex min-h-12 w-full items-center px-4 text-left text-[15px] disabled:opacity-50 ${
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
