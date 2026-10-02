import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Icon, IconTile } from "@/components/ds/Icon";

/** The same trailing chevron `ListRow`'s `chevron` draws, for rows built outside `ListRow`. */
export function SettingsChevron() {
  return (
    <span aria-hidden className="-mr-1 flex text-ink-2/80">
      <Icon icon={ChevronRight} />
    </span>
  );
}

export function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      {/* px-1: the same inset as ds `Section` headings, so every group heading in the app lines up. */}
      {/* h2: the groups sit directly under the page's h1 (AX-11, R1). */}
      <h2 className="mb-2 px-1 text-caption font-normal text-ink-2">{label}</h2>
      <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
        {children}
      </div>
    </section>
  );
}

/** A settings navigation row. Give every row in a group an `icon`, or none. */
export function SettingsRow({
  href,
  label,
  hint,
  icon,
}: {
  href: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
}) {
  return (
    // A full-width row tints when pressed; it never scales (C7, IA-15).
    <Link prefetch={true} href={href} className="settings-row press-row flex min-h-16 items-center gap-3 px-4 py-3 touch-target">
      {icon ? (
        <IconTile>
          <Icon icon={icon} />
        </IconTile>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="settings-row-title block text-body font-medium text-ink">{label}</span>
        {hint && <span className="settings-row-hint mt-0.5 block text-caption text-ink-2">{hint}</span>}
      </span>
      <SettingsChevron />
    </Link>
  );
}
