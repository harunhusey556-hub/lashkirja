import type { ReactNode } from "react";

export function BottomActions({ children }: { children: ReactNode }) {
  return (
    <>
      <div aria-hidden className="h-32" />
      <div
        className="fixed inset-x-0 z-30 bg-canvas/95 px-4 pt-3 backdrop-blur-sm md:left-[var(--app-sidebar-width,0px)]"
        style={{ bottom: "var(--usable-bottom, 0px)", paddingBottom: "calc(12px + var(--safe-bottom, 0px))" }}
      >
        <div className="mx-auto flex max-w-lg flex-col gap-2 md:max-w-3xl">{children}</div>
      </div>
    </>
  );
}
