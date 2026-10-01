import Link from "next/link";
import { Plus } from "lucide-react";
import { Icon } from "./Icon";
import { hapticImpact } from "@/lib/haptics";

// VS-03, R16, R19: the one header action. A 36px ink pill (44px hit area from the `before` layer) with a
// plus and the object's own label: "Uusi lasku", "Uusi kuitti", "Uusi asiakas", "Uusi toistuva lasku",
// "Uusi ostolasku". Nothing sits next to it: no "···", no second circle. The same words go on the
// empty-state CTA and on the Lisää sheet row.
const PILL =
  "active-press relative inline-flex min-h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-ink px-3.5 text-caption font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

export function HeaderAddPill({ label, href, onClick }: { label: string; href?: string; onClick?: () => void }) {
  const content = (
    <>
      <Icon icon={Plus} size="inline" strokeWidth={2} />
      {label}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={PILL} onClick={() => void hapticImpact("light")}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        void hapticImpact("light");
        onClick?.();
      }}
      className={PILL}
    >
      {content}
    </button>
  );
}
