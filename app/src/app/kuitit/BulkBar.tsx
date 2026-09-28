import { Button } from "@/components/ui";

/**
 * The sticky bar shown once one or more receipts are checkbox-selected.
 *
 * Deliberately NOT the `BottomActions` ds component: that one assumes the
 * tab bar is hidden (it only ever ships on `kind: "detail"` pages - see
 * AppShell's `isDetail`/`data-tabs="hidden"`), and sits at `z-30`, below the
 * tab bar's `z-50`. `/kuitit` keeps its tab bar, so a `BottomActions` bar
 * would visually float above the tab bar but the tab bar's own hit-testing
 * would still win, making every button in it unclickable (caught by the
 * elementFromPoint probe - see the task report). This bar instead floats
 * above the tab bar (`z-55`) the same way the page's old bulk-action pill
 * did, just above the tab bar rather than sharing its row.
 */
export function BulkBar({
  count,
  busy,
  onCancel,
  onDeleteRequest,
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onDeleteRequest: () => void;
}) {
  return (
    <div
      className="fixed inset-x-0 z-[55] flex justify-center px-4 md:left-[var(--app-sidebar-width,0px)]"
      style={{ bottom: "calc(var(--app-tab-height) + var(--safe-bottom) + 0.75rem)" }}
    >
      <div className="flex w-full max-w-sm items-center gap-3 rounded-card bg-ink px-4 py-2.5 text-canvas">
        <span className="text-[13px] font-medium">{count} valittu</span>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Peruuta
          </Button>
          <Button
            type="button"
            variant="danger"
            busy={busy}
            busyLabel="Poistetaan…"
            onClick={onDeleteRequest}
          >
            Poista
          </Button>
        </div>
      </div>
    </div>
  );
}
