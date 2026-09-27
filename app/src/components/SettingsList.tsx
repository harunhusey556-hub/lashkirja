import Link from "next/link";

export function SettingsChevron() {
  return (
    <svg
      className="w-4 h-4 text-warm-gray-light shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
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
    <section>
      <h3 className="px-4 mb-2 text-[13px] font-normal text-ink-2">
        {label}
      </h3>
      <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-4 py-3.5 transition-colors active:bg-blush/30 touch-target"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] font-medium text-ink">{label}</span>
        {hint && <span className="block text-[13px] text-ink-2 truncate mt-0.5">{hint}</span>}
      </span>
      <SettingsChevron />
    </Link>
  );
}
