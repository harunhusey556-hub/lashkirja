import type { DashboardItemKind } from "@/app/api/dashboard/items";

/**
 * Which Koti item kinds do not stop a month from being closed (FP-2, spec §5.1).
 *
 * Client-safe on purpose: the server module `api/dashboard/items.ts` reaches the
 * database, so the app's screens must never import a VALUE from it. Types only
 * (erased at build time) and the helpers here.
 */
export const NON_BLOCKING_KINDS: ReadonlySet<DashboardItemKind> = new Set(["overdue_invoice"]);

export function isBlockingKind(kind: DashboardItemKind): boolean {
  return !NON_BLOCKING_KINDS.has(kind);
}
