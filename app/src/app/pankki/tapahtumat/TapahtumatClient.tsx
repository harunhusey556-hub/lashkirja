"use client";

import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Landmark, RefreshCw, Settings } from "lucide-react";
import { ErrorState, SkeletonList } from "@/components/AsyncState";
import { EmptyState } from "@/components/ScreenState";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatMonth, type StatementData, type StatementTransaction } from "@/lib/statement-client";
import { formatEur } from "@/lib/format";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { useScrollRestoration } from "@/lib/list-ui-state";
import { Button } from "@/components/ui";
import { FilterChips, Icon, ListRow, PageTitle, SearchField, Section, useSkeletonFade } from "@/components/ds";
import { useLeavingRows } from "@/components/useLeavingRows";
import BankConnectCard from "@/components/BankConnectCard";
import { BankLogo } from "@/components/bank/BankPickerSheet";
import { BankRowSheet } from "@/components/bank/BankRowSheet";
import { BankFeedRow } from "@/components/bank/BankFeedRow";
import type { RowPatches } from "@/components/bank/BankBulkActions";
import { focusRowId } from "@/lib/bank-feed-focus";
import { useBankConnections } from "@/components/bank/useBankConnections";
import { useStatementUpload } from "@/components/bank/useStatementUpload";
import { accountSubline, type BankConnectionSummary } from "@/lib/bank-status";
import { feedRows, groupByMonth, matchesSearch, needsAction, rowState } from "@/lib/bank-feed";
import {
  MAX_RELOAD_PAGES,
  STATEMENT_SUMMARY_URL,
  applySummaries,
  mergeStatementsPage,
  openTotal,
  readStatementsPage,
  readSummaries,
  reuseEqualRows,
  statementsUrl,
  type StatementSummary,
} from "@/lib/bank-feed-pages";
import { applySyncBalances, isSyncNotice, syncOutcomeMessage, type AccountSyncRow, type SyncBalanceAnswer } from "@/lib/bank-sync-summary";
import { useRefetchOnDataVersion } from "@/components/useDataVersion";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import {
  clearPendingCapture,
  HANDOFF_MAX_AGE_MS,
  PENDING_CAPTURE_PARAMS,
  stripPendingCaptureFlag,
  takePendingCapture,
} from "@/lib/pending-capture";
import { tintedButtonClass } from "@/components/control-styles";

/** Months painted at first; older ones come in on request. */
const FIRST_MONTHS = 3;
const MORE_MONTHS = 6;
/** Below this many rows a search field is more clutter than help. */
const SEARCH_FROM_ROWS = 15;

type View = "" | "toimet";

// Only select mode needs the bar, the confirmations and the match sheet.
const BankBulkActions = dynamic(() => import("@/components/bank/BankBulkActions").then((module) => module.BankBulkActions), {
  ssr: false,
});

/** The connected accounts at the top: balance, when fetched, and a refresh. */
function AccountsCard({
  bank,
  onSynced,
}: {
  bank: ReturnType<typeof useBankConnections>;
  onSynced: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const connections = (bank.data?.connections ?? []).filter(
    (connection) => connection.status === "active" && connection.accounts.some((account) => account.inScope)
  );
  if (connections.length === 0) return null;
  // What the last sync left out or shortened, as the bank connection stored it.
  const notes = connections.map((connection) => connection.lastError).filter((text) => isSyncNotice(text));

  async function sync(connection: BankConnectionSummary) {
    if (busyId) return;
    setBusyId(connection.id);
    try {
      const response = await apiFetch(`/api/bank/connections/${connection.id}/sync`, { method: "POST" });
      const data = await readJson<
        { imported: number; accounts?: AccountSyncRow[]; notice?: string | null } & SyncBalanceAnswer
      >(response, "Päivitys epäonnistui");
      // The balances the sync returned go on screen before anything is refetched.
      bank.updateConnections((list) => applySyncBalances(list, connection.id, data, new Date().toISOString()));
      const outcome = syncOutcomeMessage(data.accounts || [], data.imported, data.notice ?? null);
      void hapticNotify(outcome.tone === "ok" ? "success" : "warning");
      // Something waiting is told as a note, never as the green all-clear.
      showToast({
        tone: outcome.tone === "ok" ? "success" : outcome.tone === "note" ? "info" : "error",
        text: outcome.text,
      });
      bank.reload();
      onSynced();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      void hapticNotify("error");
      showToast({ tone: "error", text: errorMessage(error, "Päivitys epäonnistui. Yritä uudelleen.") });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
      {connections.flatMap((connection) =>
        connection.accounts
          .filter((account) => account.inScope)
          .map((account, index) => (
            <div key={account.id} className="flex min-h-16 items-center gap-3 px-4 py-3">
              <BankLogo name={connection.aspspName} logo={connection.aspspLogo} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium text-ink">{account.label?.trim() || connection.aspspName}</p>
                {/* Wraps instead of clipping: the update time is the part that matters at 390 px. */}
                <p className="text-caption text-ink-2">{accountSubline(account.iban, connection.lastSuccessAt)}</p>
              </div>
              {account.balance != null && (
                <span className="shrink-0 text-body font-semibold tabular-nums text-ink">{formatEur(account.balance)}</span>
              )}
              {index === 0 && (
                <button
                  type="button"
                  onClick={() => void sync(connection)}
                  disabled={busyId !== null}
                  aria-label={`Päivitä ${connection.aspspName}`}
                  className="active-press -mr-2 flex h-11 w-11 shrink-0 items-center justify-center text-ink-2 disabled:opacity-50"
                >
                  <span className={busyId === connection.id ? "animate-spin motion-reduce:animate-none" : ""}>
                    <Icon icon={RefreshCw} size="inline" />
                  </span>
                </button>
              )}
            </div>
          ))
      )}
      {notes.map((text) => (
        <p key={text} className="px-4 py-3 text-caption text-ink-2" role="status">
          {text}
        </p>
      ))}
    </div>
  );
}

/**
 * Pankki: the one bank screen. The accounts on top, then every bank row,
 * newest month first. A row that needs the owner carries one tag, and a tap
 * opens that row's single decision (BankRowSheet). Connecting, accounts and
 * tiliote files live behind the gear (Pankkiyhteys ja tilit).
 */
export default function TapahtumatClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view: View = searchParams.get("nayta") === "toimet" ? "toimet" : "";
  const monthFilter = searchParams.get("month") ?? "";
  const [query, setQuery] = useState("");
  const [statements, setStatements] = useState<StatementData[]>(() => readPageCache<StatementData[]>("statements") ?? []);
  const [loading, setLoading] = useState(() => readPageCache<StatementData[]>("statements") === null);
  const lateStatements = useCacheAfterBoot<StatementData[]>("statements");
  const [appliedLateStatements, setAppliedLateStatements] = useState<unknown>(null);
  if (lateStatements && lateStatements !== appliedLateStatements && loading) {
    setAppliedLateStatements(lateStatements);
    setStatements(lateStatements);
    setLoading(false);
  }
  const [loadError, setLoadError] = useState<unknown>(null);
  const [monthsShown, setMonthsShown] = useState(FIRST_MONTHS);
  const [openMonths, setOpenMonths] = useState<Set<string>>(() => new Set());
  const [sheetRowId, setSheetRowId] = useState<string | null>(null);
  const { leaving, leave } = useLeavingRows();
  const [doneRowId, setDoneRowId] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const fade = useSkeletonFade(loading);
  const bank = useBankConnections();
  // Paging (W20): the feed opens on one page; the cursor of the page after it, if the server has one.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [paged, setPaged] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [serverOpen, setServerOpen] = useState<number | null>(null);
  const pagesRef = useRef(1);
  // Account and month of every statement (the paged rows carry only their ids).
  const summariesRef = useRef<StatementSummary[]>([]);
  const statementsRef = useRef(statements);
  useEffect(() => {
    statementsRef.current = statements;
  });
  // A reload that lands after a newer one started must not paint over it.
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedFreshRef = useRef<boolean | null>(null);
  // Select mode (bulk actions).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());

  /** "Vaatii toimia" counts rows past the pages on screen: the server counts them without loading the ledger. */
  const loadOpenCount = useCallback(async (fresh: boolean) => {
    try {
      const res = await apiFetch("/api/statements/counts", fresh ? { cache: "no-store" } : undefined);
      const data = await readJson<{ open?: number }>(res, "Määrien haku epäonnistui");
      setServerOpen(typeof data.open === "number" ? data.open : null);
    } catch {
      // The chip falls back to counting the rows on screen.
      setServerOpen(null);
    }
  }, []);

  const loadStatements = useCallback(
    async (fresh = false): Promise<void> => {
      // One read at a time: a request that arrives meanwhile (a sheet's reload, the version
      // poll) runs once more afterwards, so the last word is always the newest data.
      if (inFlightRef.current) {
        queuedFreshRef.current = (queuedFreshRef.current ?? false) || fresh;
        return;
      }
      inFlightRef.current = true;
      try {
        let next: boolean | null = fresh;
        while (next !== null) {
          const generation = (generationRef.current += 1);
          try {
            // First paint: one page. A reload re-reads as many pages as the owner has opened.
            const pages = Math.min(pagesRef.current, MAX_RELOAD_PAGES);
            let cursor: string | null = null;
            let merged: StatementData[] = [];
            let read = 0;
            const init = next ? ({ cache: "no-store" } as const) : undefined;
            // The first page and the statements' summary are asked together: neither waits for the other.
            const summaryRequest = apiFetch(STATEMENT_SUMMARY_URL, init)
              .then((res) => readJson<{ statements?: unknown }>(res, "Pankkitapahtumien lataus epäonnistui"))
              .then(readSummaries)
              .catch(() => summariesRef.current);
            while (read < pages) {
              const res: Response = await apiFetch(statementsUrl(cursor), init);
              const page = readStatementsPage(await readJson(res, "Pankkitapahtumien lataus epäonnistui"));
              merged = mergeStatementsPage(merged, page.statements);
              cursor = page.nextCursor;
              read += 1;
              if (!cursor) break;
            }
            const summaries = await summaryRequest;
            if (generation !== generationRef.current) return;
            summariesRef.current = summaries;
            merged = applySummaries(merged, summaries);
            pagesRef.current = Math.max(1, read);
            writePageCache("statements", merged);
            setStatements((current) => reuseEqualRows(current, merged));
            setNextCursor(cursor);
            if (cursor) setPaged(true);
            setLoadError(null);
            const open = openTotal(summaries);
            setServerOpen(open);
            // A server without per-statement counts: ask for the one number.
            if (cursor && open === null) void loadOpenCount(next);
          } catch (error: unknown) {
            if (isUnauthorized(error)) {
              redirectToLogin();
              return;
            }
            // A background refresh that fails keeps the rows on screen; only an empty screen shows the error.
            if (statementsRef.current.length === 0) setLoadError(error);
          } finally {
            setLoading(false);
          }
          next = queuedFreshRef.current;
          queuedFreshRef.current = null;
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [loadOpenCount]
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || inFlightRef.current) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const res = await apiFetch(statementsUrl(nextCursor));
      const page = readStatementsPage(await readJson(res, "Pankkitapahtumien lataus epäonnistui"));
      if (generation !== generationRef.current) return;
      pagesRef.current += 1;
      setStatements((current) => {
        const next = applySummaries(mergeStatementsPage(current, page.statements), summariesRef.current);
        writePageCache("statements", next);
        return next;
      });
      setNextCursor(page.nextCursor);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Lisää tapahtumia ei saatu ladattua. Yritä uudelleen.") });
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  useEffect(() => {
    void loadStatements();
  }, [loadStatements]);

  // A sync, import or save (here, on another device, or by the 6-hourly job) moves the data version.
  useRefetchOnDataVersion(() => void loadStatements(true));

  useScrollRestoration("pankki", !loading);

  const uploader = useStatementUpload({
    onUploaded: ({ count, notice }) => {
      void hapticNotify("success");
      const imported = count === 1 ? "1 tapahtuma tuotu." : `${count} tapahtumaa tuotu.`;
      showToast({ tone: "success", text: notice ? `${imported} ${notice}` : imported });
      void loadStatements();
    },
  });

  // "Tuo tiliote" in the Lisää sheet already picked the file (SHELL-30): drain
  // it once and upload, never ask again. The flag is one-shot.
  const importParam =
    searchParams.get(PENDING_CAPTURE_PARAMS.statement.name) === PENDING_CAPTURE_PARAMS.statement.value;
  const drainedRef = useRef(false);
  useEffect(() => {
    if (!importParam) {
      drainedRef.current = false;
      clearPendingCapture("statement");
      return;
    }
    if (drainedRef.current) return;
    drainedRef.current = true;
    const files = takePendingCapture("statement", Date.now(), HANDOFF_MAX_AGE_MS);
    stripPendingCaptureFlag("statement");
    if (!files || files.length === 0) return;
    void uploader.upload(files[0]);
    // upload reads only state that is final at mount; one shot by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importParam]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const queryString = next.toString();
    router.replace(queryString ? `/pankki/tapahtumat?${queryString}` : "/pankki/tapahtumat", { scroll: false });
  }

  /**
   * A decision in the row sheet shows at once: the row takes its new state
   * locally, and in "Vaatii toimia" it folds out of the list after the sheet
   * has closed. The reload that follows brings the server's truth.
   */
  function handleChanged(rowId: string, patch?: Partial<StatementTransaction>) {
    if (!patch) {
      void loadStatements();
      return;
    }
    const apply = () =>
      setStatements((current) =>
        current.map((statement) => ({
          ...statement,
          transactions: statement.transactions.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
        }))
      );
    const row = statements.flatMap((statement) => statement.transactions).find((candidate) => candidate.id === rowId);
    const leavesView = view === "toimet" && row !== undefined && !needsAction({ ...row, ...patch });
    if (leavesView) {
      // 200 ms: the sheet is mostly down, so the owner sees the row go.
      leave(
        rowId,
        () => {
          apply();
          void loadStatements();
        },
        200
      );
      return;
    }
    apply();
    setDoneRowId(rowId);
    window.setTimeout(() => setDoneRowId((current) => (current === rowId ? null : current)), 900);
    void loadStatements();
  }

  const rows = useMemo(() => feedRows(statements), [statements]);
  const loadedOpenCount = useMemo(() => rows.filter(needsAction).length, [rows]);
  // Past the first page the server's count is the whole truth; never less than what is on screen.
  const openCount = nextCursor && serverOpen !== null ? Math.max(serverOpen, loadedOpenCount) : loadedOpenCount;
  const visibleRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          (!monthFilter || row.month === monthFilter) &&
          (view !== "toimet" || needsAction(row)) &&
          matchesSearch(row, query)
      ),
    [rows, monthFilter, view, query]
  );
  const months = useMemo(() => groupByMonth(visibleRows), [visibleRows]);
  // Narrowed views show everything they found; the full feed pages by month.
  const narrowed = Boolean(view || monthFilter || query.trim());
  // Once the server pages the feed, every loaded month shows (the page size bounds it); a feed
  // that arrives in one piece keeps the month-by-month reveal.
  const shownMonths = narrowed || paged ? months : months.slice(0, monthsShown);
  // A connected bank with nothing to show is not "connect your bank": say what is known.
  const connectedNote = (bank.data?.connections ?? []).find(
    (connection) => connection.status === "active" && isSyncNotice(connection.lastError)
  )?.lastError;
  const connected = (bank.data?.connections ?? []).some((connection) => connection.status === "active");
  const emptyBody = connected
    ? connectedNote ?? "Pankki on yhdistetty. Tapahtumat ilmestyvät tänne, kun pankki antaa ne."
    : "Yhdistä pankki, niin tapahtumat ilmestyvät tänne ja kohdistuvat kuitteihin.";
  const sheetRow = sheetRowId ? rows.find((row) => row.id === sheetRowId) ?? null : null;
  const focusParam = searchParams.get("rivi");
  const focusOpened = useRef(false);
  useEffect(() => {
    const id = focusRowId(focusParam, rows, focusOpened.current);
    if (!id) return;
    focusOpened.current = true;
    setSheetRowId(id);
  }, [focusParam, rows]);

  // A narrowed view (search, "Vaatii toimia", one month) or a row linked from elsewhere must see
  // every row, not just the pages opened so far: the rest streams in page by page.
  const wantsEverything = narrowed || (Boolean(focusParam) && !rows.some((row) => row.id === focusParam));
  useEffect(() => {
    if (wantsEverything && nextCursor && !loading && !loadingMore && pagesRef.current < MAX_RELOAD_PAGES) void loadMore();
  }, [wantsEverything, nextCursor, loading, loadingMore, loadMore]);

  // End of the list: the next page comes in before the owner reaches it.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const canInfiniteScroll = !narrowed && nextCursor !== null;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!canInfiniteScroll || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [canInfiniteScroll, loadMore, shownMonths.length]);

  const openRow = useCallback((id: string) => setSheetRowId(id), []);
  const toggleRow = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  function stopSelecting() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }
  // Only rows the owner can see are acted on; a filter that hides a ticked row un-ticks it.
  const selectedRows = useMemo(() => visibleRows.filter((row) => selectedIds.has(row.id)), [visibleRows, selectedIds]);
  const suggestionRows = useMemo(
    () => visibleRows.filter((row) => rowState(row) === "suggested" || rowState(row) === "sale"),
    [visibleRows]
  );
  function applyBulk(patches: RowPatches) {
    setStatements((current) =>
      current.map((statement) => ({
        ...statement,
        transactions: statement.transactions.map((row) => {
          const patch = patches.get(row.id);
          return patch ? { ...row, ...patch } : row;
        }),
      }))
    );
    // What failed stays ticked so the owner can see it and try again.
    setSelectedIds((current) => new Set([...current].filter((id) => !patches.has(id))));
    void loadStatements(true);
  }

  return (
    <div className="space-y-5">
      <PullToRefresh
        onRefresh={() => {
          setLoadError(null);
          bank.reload();
          // Skips every cached copy: the pull is the owner saying "show me the truth".
          return loadStatements(true);
        }}
      />
      <PageTitle
        title="Pankki"
        action={
          <Link
            href="/kirjanpito/pankkitilit"
            aria-label="Pankkiyhteys ja tilit"
            className="active-press flex h-11 w-11 items-center justify-center rounded-full text-ink-2"
          >
            <Icon icon={Settings} />
          </Link>
        }
      />

      {/* Not connected, or the consent needs renewing: the shared card leads (BOOKS-04). */}
      <BankConnectCard variant="compact" />
      <AccountsCard bank={bank} onSynced={() => void loadStatements(true)} />

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.length >= SEARCH_FROM_ROWS && (
            <SearchField id="bank-search" label="Hae pankkitapahtumia" value={query} onChange={setQuery} />
          )}
          <FilterChips<View>
            label="Näytä"
            items={[
              { id: "", label: "Kaikki" },
              { id: "toimet", label: "Vaatii toimia", count: openCount > 0 ? openCount : undefined },
            ]}
            value={view}
            onChange={(value) => setParam("nayta", value)}
          />
          {monthFilter && (
            <button
              type="button"
              onClick={() => setParam("month", "")}
              className={tintedButtonClass("accent")}
            >
              {formatMonth(monthFilter)} · näytä kaikki kuukaudet
            </button>
          )}
          {!loading && loadError == null && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={selectMode}
                onClick={() => (selectMode ? stopSelecting() : setSelectMode(true))}
                className={tintedButtonClass(selectMode ? "neutral" : "accent")}
              >
                {selectMode ? "Valmis" : "Valitse"}
              </button>
              {selectMode && suggestionRows.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set(suggestionRows.map((row) => row.id)))}
                  className={tintedButtonClass("accent")}
                >
                  Valitse ehdotukset ({suggestionRows.length})
                </button>
              )}
              {selectMode && visibleRows.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedIds(
                      selectedRows.length === visibleRows.length ? new Set() : new Set(visibleRows.map((row) => row.id))
                    )
                  }
                  className={tintedButtonClass("accent")}
                >
                  {selectedRows.length === visibleRows.length ? "Poista valinnat" : "Valitse kaikki näkyvät"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {uploader.input}
      {uploader.message && (
        <p
          className={`px-1 text-caption ${uploader.message.tone === "error" ? "text-danger" : "text-ink-2"}`}
          role={uploader.message.tone === "error" ? "alert" : "status"}
        >
          {uploader.message.text}
        </p>
      )}

      {loadError != null ? (
        <ErrorState
          error={loadError}
          message="Pankkitapahtumien lataus epäonnistui"
          onRetry={() => {
            setLoadError(null);
            setLoading(true);
            void loadStatements();
          }}
          compact
        />
      ) : loading ? (
        <SkeletonList rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          kind="records"
          icon={Landmark}
          title="Ei pankkitapahtumia vielä"
          body={emptyBody}
          action={
            <Button variant="secondary" busy={uploader.uploading} busyLabel="Tuodaan…" onClick={() => void uploader.pick()}>
              Tuo tiliote
            </Button>
          }
        />
      ) : months.length === 0 ? (
        view === "toimet" && !query.trim() ? (
          <EmptyState
            kind="records"
            icon={CheckCircle2}
            title="Kaikki kunnossa"
            body="Yksikään pankkitapahtuma ei odota sinua."
          />
        ) : (
          <EmptyState
            kind="filtered"
            icon={Landmark}
            title="Ei osumia"
            body="Hakuasi vastaavaa tapahtumaa ei löytynyt."
            onClear={() => setQuery("")}
            clearLabel="Tyhjennä haku"
          />
        )
      ) : (
        <div key={`${view}|${monthFilter}`} className={`space-y-1 ${fade || "list-swap"}`}>
          {shownMonths.map((group, index) => {
            // A finished month folds into one line; the newest month always shows.
            // The last month of an unfinished feed may continue on the next page: it stays open.
            const mayContinue = nextCursor !== null && index === shownMonths.length - 1;
            const folded = !narrowed && index > 0 && group.open === 0 && !openMonths.has(group.month) && !mayContinue;
            return (
              <Section
                key={group.month}
                title={group.month ? formatMonth(group.month) : "Päiväämättömät"}
                action={
                  group.open > 0 ? (
                    <span className="text-warning-dark">{group.open} avoinna</span>
                  ) : undefined
                }
              >
                {folded ? (
                  <ListRow
                    title={`${group.rows.length} tapahtumaa`}
                    secondary="Kaikki kunnossa"
                    trailing={
                      <span className="flex text-success-dark">
                        <Icon icon={CheckCircle2} size="inline" />
                      </span>
                    }
                    onClick={() => {
                      setOpenMonths((current) => new Set(current).add(group.month));
                      setUnfolded(group.month);
                    }}
                    ariaLabel={`${formatMonth(group.month)}: ${group.rows.length} tapahtumaa, kaikki kunnossa. Näytä`}
                  />
                ) : (
                  group.rows.map((row) => (
                    <BankFeedRow
                      key={row.id}
                      row={row}
                      leaving={leaving.has(row.id)}
                      done={doneRowId === row.id}
                      swap={unfolded === group.month}
                      selectMode={selectMode}
                      selected={selectedIds.has(row.id)}
                      onOpen={openRow}
                      onToggle={toggleRow}
                    />
                  ))
                )}
              </Section>
            );
          })}
          {!narrowed && months.length > shownMonths.length && (
            <Button
              type="button"
              variant="secondary"
              className="mt-4 w-full"
              onClick={() => setMonthsShown((count) => count + MORE_MONTHS)}
            >
              Näytä vanhemmat kuukaudet
            </Button>
          )}
          {canInfiniteScroll && (
            // The sentinel loads the next page before the owner gets here; the button is the fallback.
            <div ref={sentinelRef}>
              <Button
                type="button"
                variant="secondary"
                className="mt-4 w-full"
                busy={loadingMore}
                busyLabel="Ladataan…"
                onClick={() => void loadMore()}
              >
                Näytä lisää
              </Button>
            </div>
          )}
        </div>
      )}

      <BankRowSheet row={sheetRow} onClose={() => setSheetRowId(null)} onChanged={handleChanged} />

      {selectMode && <BankBulkActions rows={selectedRows} onCancel={stopSelecting} onApplied={applyBulk} />}
    </div>
  );
}
