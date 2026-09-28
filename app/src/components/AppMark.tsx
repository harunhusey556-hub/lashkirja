/**
 * The LashKirja brand mark: the app icon (`assets/app-icon.svg`) as a small rounded tile, for the
 * desktop sidebar and the lock screen. A brand mark, not a UI icon: UI glyphs come from `ds/Icon`.
 * Keep the geometry in step with `assets/app-icon.svg`.
 */
export function AppMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <rect width="1024" height="1024" rx="230" fill="#9a5650" />
      <rect x="252" y="188" width="520" height="640" rx="76" fill="#e2d4c8" />
      <rect x="252" y="188" width="520" height="600" rx="76" fill="#f6f3ef" />
      <path d="M628 188H692V330L660 304L628 330Z" fill="#7f413c" />
      <g fill="none" stroke="#26221f" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 -52)">
        <path d="M362 478Q512 618 662 478" strokeWidth="46" />
        <g strokeWidth="38">
          <path d="M512 548V650" />
          <path d="M437 530Q421 578 400 616" />
          <path d="M587 530Q603 578 624 616" />
          <path d="M377 491Q352 526 322 552" />
          <path d="M647 491Q672 526 702 552" />
        </g>
      </g>
    </svg>
  );
}
