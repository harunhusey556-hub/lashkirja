import { badgeClass, type BadgeTone } from "@/lib/status-badge";

export function StatusBadge({
  tone,
  children,
  count,
}: {
  tone: BadgeTone;
  children: React.ReactNode;
  count?: number;
}) {
  const named = typeof children === "string" ? children : undefined;
  const aria = count != null && named ? `${count} ${named}` : undefined;
  return (
    <span className={badgeClass(tone)} data-tone={tone} aria-label={aria}>
      {count != null && <span className="tabular-nums">{count}</span>}
      {children ? children : null}
    </span>
  );
}
