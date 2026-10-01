"use client";

import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Landmark, RefreshCw, Settings } from "lucide-react";
import { ErrorState, SkeletonList } from "@/components/AsyncState";
import { EmptyState } from "@/components/ScreenState";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatMonth, type StatementData, type StatementTransaction } from "@/lib/statement-client";
import { formatDayMonth, formatEur, formatEurSigned } from "@/lib/format";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { useScrollRestoration } from "@/lib/list-ui-state";
import { Button } from "@/components/ui";
import { FilterChips, Icon, ListRow, PageTitle, SearchField, Section, StatusTag, useSkeletonFade } from "@/components/ds";
import { useLeavingRows } from "@/components/useLeavingRows";
import BankConnectCard from "@/components/BankConnectCard";
import { BankLogo } from "@/components/bank/BankPickerSheet";
import { BankRowSheet } from "@/components/bank/BankRowSheet";
import { useBankConnections } from "@/components/bank/useBankConnections";
import { useStatementUpload } from "@/components/bank/useStatementUpload";
import { accountSubline, type BankConnectionSummary } from "@/lib/bank-status";
import { feedRows, groupByMonth, matchesSearch, needsAction, rowState, type FeedRow } from "@/lib/bank-feed";
import { isSyncNotice, syncOutcomeMessage, type AccountSyncRow } from "@/lib/bank-sync-summary";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import {
  clearPendingCapture,
  HANDOFF_MAX_AGE_MS,
  PENDING_CAPTURE_PARAMS,
  stripPendingCaptureFlag,
  takePendingCapture,
} from "@/lib/pending-capture";

/** Months painted at first; older ones come in on request. */
const FIRST_MONTHS = 3;
const MORE_MONTHS = 6;
/** Below this many rows a search field is more clutter than help. */
const SEARCH_FROM_ROWS = 15;

type View = "" | "toimet";

const ROW_TAG: Partial<Record<ReturnType<typeof rowState>, { tone: "warning" | "accent"; label: string }>> = {
  sale: { tone: "warning", label: "Hyväksy myynti" },
  suggested: { tone: "accent", label: "Tarkista" },
};

/** "Maksu laskulle 5": the row is done because an invoice took it (F12). */
function invoicePaymentNote(row: FeedRow): string {
  if (row.paidInvoice) return `Maksu laskulle ${row.paidInvoice.number}`;
  return row.settlesPurchase ? "Maksu ostolaskulle" : "Kunnossa";
}

function rowSecondary(row: FeedRow): string {
  const day = row.date ? formatDayMonth(row.date) : "";
  const state = rowState(row);
  const note =
    state === "linked"
      ? "Kunnossa"
      : state === "invoice"
        ? invoicePaymentNote(row)
        : state === "ignored"
        ? "Ei kuittia tarvita"
        : state === "transfer"
          ? row.type === "palkka"
            ? "Palkka"
            : "Oma siirto"
          : state === "missing"
            ? row.amount > 0
              ? "Kuittia ei vielä ole"
              : "Kuitti puuttuu"
            : "";
  return [day, note].filter(Boolean).join(" · ");
}

function rowTag(row: FeedRow) {
  const state = rowState(row);
  if (state === "missing") {
    return <StatusTag tone="warning">{row.amount > 0 ? "Puuttuu" : "Uusi kuitti"}</StatusTag>;
  }
  const tag = ROW_TAG[state];
  return tag ? <StatusTag tone={tag.tone}>{tag.label}</StatusTag> : null;
}

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
      const data = await readJson<{ imported: number; accounts?: AccountSyncRow[]; notice?: string | null }>(
        response,
        "Päivitys epäonnistui"
      );
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

  const loadStatements = useCallback(async () => {
    try {
      const res = await apiFetch("/api/statements");
      const data = await readJson<{ statements?: StatementData[] }>(res, "Pankkitapahtumien lataus epäonnistui");
      writePageCache("statements", data.statements || []);
      setStatements(data.statements || []);
      setLoadError(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: storing the response is the external sync this effect exists for
    void loadStatements();
  }, [loadStatements]);

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
    router.replace(queryString ? `/pankki/tapahtumat?${queryString}` : "/pankki/tapahtumat");
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
  const openCount = useMemo(() => rows.filter(needsAction).length, [rows]);
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
  const shownMonths = narrowed ? months : months.slice(0, monthsShown);
  // A connected bank with nothing to show is not "connect your bank": say what is known.
  const connectedNote = (bank.data?.connections ?? []).find(
    (connection) => connection.status === "active" && isSyncNotice(connection.lastError)
  )?.lastError;
  const connected = (bank.data?.connections ?? []).some((connection) => connection.status === "active");
  const emptyBody = connected
    ? connectedNote ?? "Pankki on yhdistetty. Tapahtumat ilmestyvät tänne, kun pankki antaa ne."
    : "Yhdistä pankki, niin tapahtumat ilmestyvät tänne ja kohdistuvat kuitteihin.";
  const sheetRow = sheetRowId ? rows.find((row) => row.id === sheetRowId) ?? null : null;

  return (
    <div className="space-y-5">
      <PullToRefresh
        onRefresh={() => {
          setLoadError(null);
          return loadStatements();
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
      <AccountsCard bank={bank} onSynced={() => void loadStatements()} />

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
              className="active-press flex min-h-11 items-center px-1 text-caption font-medium text-accent"
            >
              {formatMonth(monthFilter)} · näytä kaikki kuukaudet
            </button>
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
            const folded = !narrowed && index > 0 && group.open === 0 && !openMonths.has(group.month);
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
                    <div
                      key={row.id}
                      className={
                        [
                          leaving.has(row.id) ? "row-leave" : "",
                          doneRowId === row.id ? "row-done" : "",
                          unfolded === group.month ? "list-swap" : "",
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                    >
                      <ListRow
                        title={row.counterparty || (row.amount > 0 ? "Tulo" : "Meno")}
                        secondary={rowSecondary(row)}
                        amount={formatEurSigned(row.amount)}
                        amountTone={row.amount > 0 ? "positive" : "default"}
                        trailing={rowTag(row)}
                        onClick={() => setSheetRowId(row.id)}
                      />
                    </div>
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
        </div>
      )}

      <BankRowSheet row={sheetRow} onClose={() => setSheetRowId(null)} onChanged={handleChanged} />
    </div>
  );
}
