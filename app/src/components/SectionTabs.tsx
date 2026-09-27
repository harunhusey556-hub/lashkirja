"use client";

import { useRouter } from "next/navigation";
import { chipClass } from "@/components/control-styles";
import { armNavigation } from "@/lib/nav-direction";

export function SectionTabs({
  items,
  activeHref,
  label = "Osio",
}: {
  items: Array<{ href: string; label: string }>;
  activeHref: string;
  label?: string;
}) {
  const router = useRouter();
  return (
    <nav aria-label={label} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {items.map((item) => {
        const active = item.href === activeHref;
        return (
          <button
            key={item.href}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (active) return;
              armNavigation(item.href, "tab");
              router.push(item.href);
            }}
            className={chipClass(active)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
