import Link from "next/link";

export function WorkspaceLinks({
  items,
}: {
  items: Array<{ href: string; label: string; active?: boolean }>;
}) {
  return (
    <nav aria-label="Osio" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={`active-press inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm font-medium ${
            item.active ? "bg-charcoal text-white" : "bg-white text-charcoal"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function linksWithActive(
  items: readonly { href: string; label: string }[],
  activeHref: string
) {
  return items.map((item) => ({ ...item, active: item.href === activeHref }));
}

export const INVOICE_LINKS = [
  { href: "/laskut", label: "Myynti" },
  { href: "/ostolaskut", label: "Ostot" },
  { href: "/asiakkaat", label: "Asiakkaat" },
  { href: "/toistuvat", label: "Toistuvat" },
] as const;

export const BANK_LINKS = [
  { href: "/pankkitilit", label: "Tilit" },
  { href: "/tiliotteet", label: "Tiliotteet" },
  { href: "/asetukset#pankkiyhteys", label: "Pankkiyhteys" },
] as const;

export const REPORT_LINKS = [
  { href: "/raportit", label: "Tulos" },
  { href: "/alv-raportti", label: "ALV" },
] as const;
