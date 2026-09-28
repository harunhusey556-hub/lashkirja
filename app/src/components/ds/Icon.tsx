import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The app's one icon set is Lucide (`lucide-react`, ISC licence): every glyph is drawn on the same
 * 24px grid with the same round caps and joins, so icons from different screens always match.
 * Never hand-draw an inline <svg> for UI chrome; pick the Lucide glyph and render it through `Icon`.
 *
 * Sizes (px) are fixed per placement so the same kind of icon is the same size everywhere:
 * - `inline` 16: inside a chip, pill, text button or next to 13-15px text
 * - `row`    20: leading icons in `IconTile` / `ListRow`, sheet rows, header buttons, chevrons in rows
 * - `tab`    24: the mobile tab bar
 * - `hero`   28: the round tile of an empty, error or confirm state
 *
 * Stroke: 1.75 (on the 24px grid) at 20px and up, which renders close to the stem weight of 15px
 * Inter medium; 2 at 16px, where a thinner line would read as grey rather than ink.
 */
export const ICON_SIZE = { inline: 16, row: 20, tab: 24, hero: 28 } as const;
export type IconSize = keyof typeof ICON_SIZE;

export function Icon({
  icon: Glyph,
  size = "row",
  className = "",
  strokeWidth,
}: {
  icon: LucideIcon;
  size?: IconSize;
  className?: string;
  strokeWidth?: number;
}) {
  const px = ICON_SIZE[size];
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      width={px}
      height={px}
      strokeWidth={strokeWidth ?? (px <= 16 ? 2 : 1.75)}
      className={`shrink-0 ${className}`}
    />
  );
}

/** The 36px rounded leading tile used by `ListRow`, the Lisää sheet and the profile sheet. */
export function IconTile({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "danger" }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-canvas ${
        tone === "danger" ? "text-danger" : "text-ink-2"
      }`}
    >
      {children}
    </span>
  );
}
