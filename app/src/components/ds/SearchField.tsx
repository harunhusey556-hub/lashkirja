"use client";

import { Search } from "lucide-react";
import { controlClass } from "@/components/control-styles";
import { Icon } from "./Icon";

/**
 * The one search field (VS-21, R25): 48px, `type=search`, a leading magnifier, the placeholder
 * "Hae …". The name of what is searched goes in `label` (the accessible name), never in the
 * placeholder. Filters sit in a `FilterChips` row directly below it.
 */
export function SearchField({ label, value, onChange, id, placeholder = "Hae …" }: {
  label: string; value: string; onChange: (value: string) => void; id?: string; placeholder?: string;
}) {
  return (
    <div className="relative">
      <span aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-2">
        <Icon icon={Search} size="inline" />
      </span>
      <input
        id={id}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        className={`${controlClass} pl-10`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
      />
    </div>
  );
}
