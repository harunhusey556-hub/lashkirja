import { apiFetch } from "@/components/clientFetch";
import { helsinkiMonthKey } from "@/lib/validation";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { readStatementsPage, statementsUrl } from "@/lib/bank-feed-pages";
import {
  DEFAULT_RECEIPT_COUNTS_QUERY,
  DEFAULT_RECEIPT_QUERY,
  readReceiptPage,
  receiptPageQuery,
  type ReceiptPageResponse,
} from "@/lib/receipt-paging";

/**
 * Data a main screen paints from, fetched before the screen is opened so the
 * first frame is rows, not a skeleton. Keys and shapes mirror what each page
 * caches for itself (a page that finds the key reads it synchronously); an
 * entry that is already cached is never overwritten and never fetched again,
 * and one request per key is in flight at a time.
 */
interface Warmer {
  key: string;
  url: string;
  pick: (data: Record<string, unknown>) => unknown;
}

function warmersFor(path: string): Warmer[] {
  if (path === "/dashboard" || path.startsWith("/dashboard/")) {
    const month = helsinkiMonthKey();
    return [
      {
        key: `dashboard:${month}`,
        url: `/api/dashboard?month=${month}`,
        pick: (d) => (Number.isFinite(d.income) && Number.isFinite(d.expenses) && d.vat ? d : undefined),
      },
    ];
  }
  if (path === "/laskut") {
    return [{ key: "invoices", url: "/api/invoices?", pick: (d) => (d.invoices && d.aging ? d : undefined) }];
  }
  if (path === "/kuitit") {
    return [
      {
        key: `receipts:${DEFAULT_RECEIPT_QUERY}`,
        url: `/api/receipts?${receiptPageQuery(DEFAULT_RECEIPT_QUERY)}`,
        pick: (d) => (Array.isArray(d.receipts) ? readReceiptPage(d as ReceiptPageResponse<unknown>) : undefined),
      },
      {
        key: "receipts-pending",
        url: "/api/receipts?reviewStatus=pending&kind=receipt",
        pick: (d) => (Array.isArray(d.receipts) ? readReceiptPage(d as ReceiptPageResponse<unknown>) : undefined),
      },
      {
        key: `receipt-counts:${DEFAULT_RECEIPT_COUNTS_QUERY}`,
        url: `/api/receipts/counts?${DEFAULT_RECEIPT_COUNTS_QUERY}`,
        pick: (d) => d.counts ?? undefined,
      },
    ];
  }
  if (path === "/pankki/tapahtumat") {
    return [
      // One page, not the ledger: the whole list was the 5 s request the warm-up used to start.
      { key: "statements", url: statementsUrl(null), pick: (d) => readStatementsPage(d).statements },
      { key: "bank-overview", url: "/api/bank-accounts", pick: (d) => (d.accounts ? d : undefined) },
    ];
  }
  if (path === "/raportit") {
    const year = new Date().getUTCFullYear();
    return [
      {
        key: `report:${year}`,
        url: `/api/reports/profit-loss?from=${year}-01&to=${year}-12`,
        pick: (d) => d,
      },
    ];
  }
  return [];
}

const inFlight = new Map<string, Promise<void>>();

function warm({ key, url, pick }: Warmer): Promise<void> {
  if (readPageCache(key) !== null) return Promise.resolve();
  const running = inFlight.get(key);
  if (running) return running;
  const request = apiFetch(url, { credentials: "include" })
    .then((res) => (res.ok ? (res.json() as Promise<Record<string, unknown>>) : null))
    .then((data) => {
      if (!data) return;
      const value = pick(data);
      if (value !== undefined && readPageCache(key) === null) writePageCache(key, value);
    })
    .catch(() => {
      // Warm-up only; the page's own fetch will surface real errors.
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Fetch what the screen at `path` opens with (a tab or a main list row was touched or hovered). */
export function warmRoute(path: string): Promise<void> {
  return Promise.all(warmersFor(path.split("?")[0] ?? path).map(warm)).then(() => undefined);
}

/**
 * A receipt row was touched or hovered: fetch the full receipt now, so the
 * detail screen (which paints from `receipt:<id>`) opens filled in.
 */
export function warmReceipt(id: string): Promise<void> {
  return warm({
    key: `receipt:${id}`,
    url: `/api/receipts/${encodeURIComponent(id)}`,
    pick: (d) => d.receipt ?? undefined,
  });
}

/** The main screens in the order the owner reaches them. */
export const MAIN_ROUTES = ["/dashboard", "/laskut", "/kuitit", "/pankki/tapahtumat", "/raportit"] as const;

/**
 * Launch warm-up of every main screen. Web: all at once, in parallel. Mobile:
 * one screen at a time so it never competes with the page's own request on a
 * slow link (SHELL-08).
 */
export async function warmMainRoutes(sequential: boolean): Promise<void> {
  if (sequential) {
    for (const path of MAIN_ROUTES) await warmRoute(path);
  } else {
    await Promise.all(MAIN_ROUTES.map((path) => warmRoute(path)));
  }
}
