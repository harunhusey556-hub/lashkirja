"use client";

import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ErrorState, SkeletonList } from "@/components/AsyncState";
import { EmptyState } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import {
  formatMonth,
  type StatementData,
} from "@/lib/statement-client";
import { formatEurSigned } from "@/lib/format";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { chooseDocuments, isNativeShell } from "@/lib/native-pick";
import { Button, controlClass } from "@/components/ui";
import { FileText } from "lucide-react";
import { FilterChips, ListRow, PageTitle, SearchField, Section, StatusTag } from "@/components/ds";
import { detailHref } from "@/lib/routes";
import BankConnectCard from "@/components/BankConnectCard";
import {
  clearPendingCapture,
  HANDOFF_MAX_AGE_MS,
  PENDING_CAPTURE_PARAMS,
  STATEMENT_FILE_TYPES,
  stripPendingCaptureFlag,
  takePendingCapture,
} from "@/lib/pending-capture";

const RECENT_LIMIT = 5;

interface BankAccountOption {
  id: string;
  name: string;
  bankName: string | null;
  isDefault: boolean;
}

export default function TapahtumatClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const monthFilter = searchParams.get("month") ?? "";
  const accountFilter = searchParams.get("account") ?? "";
  const query = searchParams.get("q") ?? "";
  const [statements, setStatements] = useState<StatementData[]>(
    () => readPageCache<StatementData[]>("statements") ?? []
  );
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [loading, setLoading] = useState(
    () => readPageCache<StatementData[]>("statements") === null
  );
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton (N3).
  const lateStatements = useCacheAfterBoot<StatementData[]>("statements");
  const [appliedLateStatements, setAppliedLateStatements] = useState<unknown>(null);
  if (lateStatements && lateStatements !== appliedLateStatements && loading) {
    setAppliedLateStatements(lateStatements);
    setStatements(lateStatements);
    setLoading(false);
  }
  const [showAllStatements, setShowAllStatements] = usePersistedState(
    "tiliotteet.showAllStatements",
    false
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [accounts, setAccounts] = useState<BankAccountOption[]>(
    () => readPageCache<{ accounts?: BankAccountOption[] }>("bank-overview")?.accounts ?? []
  );
  const [targetAccountId, setTargetAccountId] = useState(
    () =>
      (readPageCache<{ accounts?: BankAccountOption[] }>("bank-overview")?.accounts ?? []).find(
        (a) => a.isDefault
      )?.id || ""
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** The list state carried into a detail link; the one-shot import flag stays behind. */
  function listParams(): Record<string, string> {
    const params = Object.fromEntries(searchParams.entries());
    delete params[PENDING_CAPTURE_PARAMS.statement.name];
    return params;
  }

  function replaceQuery(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const queryString = next.toString();
    router.replace(queryString ? `/pankki/tapahtumat?${queryString}` : "/pankki/tapahtumat");
  }

  const loadStatements = useCallback(async () => {
    try {
      const res = await apiFetch("/api/statements");
      const data = await readJson<{ statements?: StatementData[] }>(
        res,
        "Tiliotteiden lataus epäonnistui"
      );
      writePageCache("statements", data.statements || []);
      setStatements(data.statements || []);
      setLoadError(null);
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      // The error object, not its text: ConnectionNotice words it (BOOKS-15).
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void loadStatements();
  }, [loadStatements]);

  useScrollRestoration("tiliotteet", !loading);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/bank-accounts", { credentials: "include" })
      .then((res) => readJson<{ accounts?: BankAccountOption[] }>(res, ""))
      .then((data) => {
        if (cancelled) return;
        const list = data.accounts || [];
        setAccounts(list);
        // Keep whatever the user (or the cached default) already picked; only
        // fill the default in when nothing is selected yet.
        setTargetAccountId((current) =>
          current && list.some((a) => a.id === current)
            ? current
            : list.find((a) => a.isDefault)?.id || ""
        );
      })
      // The picker is a convenience; the upload still works without it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadMsg("Käsitellään tiliotetta...");
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (targetAccountId) fd.append("bankAccountId", targetAccountId);

      const res = await apiFetch("/api/statements", {
        method: "POST",
        body: fd,
        timeoutMs: 120_000,
      });
      const data = await readJson<{
        count: number;
        statement?: { id?: string };
      }>(res, "Tiliotteen käsittely epäonnistui");
      setUploadMsg(`${data.count} tapahtumaa löydetty`);
      if (data.statement?.id) {
        router.push(detailHref("statement", data.statement.id, listParams()));
      } else {
        await loadStatements();
      }
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setUploadMsg(`Virhe: ${errorMessage(error, "Lataus epäonnistui")}`);
    } finally {
      setUploading(false);
    }
  }

  async function pickStatementFile() {
    if (!isNativeShell()) {
      fileInputRef.current?.click();
      return;
    }
    const picked = await chooseDocuments(STATEMENT_FILE_TYPES);
    if (picked.kind === "unavailable") {
      fileInputRef.current?.click();
      return;
    }
    if (picked.kind === "denied") {
      setUploadMsg(picked.message);
      return;
    }
    const file = picked.kind === "files" ? picked.files[0] : null;
    if (file) void handleUpload(file);
  }

  // "Tuo tiliote" in the Lisää sheet already picked the file (SHELL-30):
  // drain it once and go straight to processing, never ask again.
  const importParam = searchParams.get(PENDING_CAPTURE_PARAMS.statement.name) === PENDING_CAPTURE_PARAMS.statement.value;
  const drainedRef = useRef(false);
  const importSectionRef = useRef<HTMLDivElement>(null);
  // The flag is one-shot: once drained it is stripped from the URL, so the next
  // "Tuo tiliote" from the Lisää sheet changes the URL again and drains again
  // (a repeated push of the same URL used to be dropped silently). Without the
  // flag any leftover stash is cleared, so the dashboard's plain
  // `?import=1` link can never upload a stale file unasked.
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
    importSectionRef.current?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hand-off from the Lisää sheet: the upload it starts is the external work this effect exists for
    void handleUpload(files[0]);
    // handleUpload reads only state that is final at mount; one shot by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importParam]);

  const months = [
    ...new Set(
      [
        ...statements.map((s) => s.periodMonth).filter((m): m is string => !!m),
        ...(monthFilter ? [monthFilter] : []),
      ]
    ),
  ].sort().reverse();

  const filteredStatements = statements.filter((s) => {
    if (monthFilter && s.periodMonth !== monthFilter) return false;
    if (accountFilter && s.bankAccountId !== accountFilter) return false;
    if (query) {
      const haystack = `${s.fileName} ${s.bankAccount?.name ?? ""}`.toLowerCase();
      if (!haystack.includes(query.trim().toLowerCase())) return false;
    }
    return true;
  });
  const visibleStatements = showAllStatements
    ? filteredStatements
    : filteredStatements.slice(0, RECENT_LIMIT);
  const hasFilters = Boolean(monthFilter || accountFilter || query);

  return (
    <div className="space-y-6">
      {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
      <PullToRefresh onRefresh={() => {
          setLoadError(null);
          return loadStatements();
        }} />
      {/* R4: a root-level list carries no subtitle. */}
      <PageTitle title="Tapahtumat" />

      {/* No bank connected yet: the shared connect card leads (BOOKS-04). */}
      <BankConnectCard variant="compact" />

      {/* VS-21, R25: one search field with the filters as chip rows directly below it. Nothing to filter, nothing shown. */}
      {statements.length > 0 && (
        <div className="space-y-3">
          <SearchField
            id="statement-search"
            label="Hae tiliotteita"
            value={query}
            onChange={(value) => {
              replaceQuery({ q: value });
              setShowAllStatements(false);
            }}
          />
          {months.length > 0 && (
            <FilterChips
              label="Suodata kuukauden mukaan"
              items={[
                { id: "", label: "Kaikki kuukaudet" },
                ...months.map((month) => ({ id: month, label: formatMonth(month) })),
              ]}
              value={monthFilter}
              onChange={(value) => {
                replaceQuery({ month: value });
                setShowAllStatements(false);
              }}
            />
          )}
          {accounts.length > 1 && (
            <FilterChips
              label="Suodata tilin mukaan"
              items={[
                { id: "", label: "Kaikki tilit" },
                ...accounts.map((account) => ({ id: account.id, label: account.name })),
              ]}
              value={accountFilter}
              onChange={(value) => {
                replaceQuery({ account: value });
                setShowAllStatements(false);
              }}
            />
          )}
        </div>
      )}

      <div ref={importSectionRef} className="scroll-mt-4">
      <Section title="Tuo tiliote tiedostona">
        <div className="space-y-4 px-4 py-4">
          <p className="text-caption text-ink-2">PDF, XML, XLSX tai CSV</p>

          {accounts.length > 0 && (
            <div>
              <label htmlFor="statement-target-account" className="mb-1.5 block text-caption font-normal text-ink-2">
                Pankkitili
              </label>
              <select
                id="statement-target-account"
                value={targetAccountId}
                onChange={(e) => setTargetAccountId(e.target.value)}
                className={controlClass}
              >
                <option value="">Tunnista automaattisesti</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                    {account.bankName ? ` · ${account.bankName}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            className="w-full"
            busy={uploading}
            busyLabel="Käsitellään…"
            onClick={() => void pickStatementFile()}
          >
            Tuo tiedosto
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.xml,.xlsx,.xls,.csv"
            aria-label="Valitse tiliote"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.currentTarget.value = "";
            }}
          />

          {uploadMsg && (
            <p
              className={`text-caption ${
                uploading
                  ? "text-ink-2"
                  : uploadMsg.startsWith("Virhe")
                    ? "text-danger"
                    : "text-success"
              }`}
              role={uploadMsg.startsWith("Virhe") ? "alert" : "status"}
              aria-live="polite"
            >
              {uploadMsg}
            </p>
          )}
        </div>
      </Section>
      </div>

      {loadError != null ? (
        <ErrorState
          error={loadError}
          message="Tiliotteiden lataus epäonnistui"
          onRetry={() => {
            setLoadError(null);
            setLoading(true);
            void loadStatements();
          }}
          compact
        />
      ) : loading ? (
        <SkeletonList rows={4} />
      ) : visibleStatements.length === 0 ? (
        <EmptyState
          kind={hasFilters ? "filtered" : "records"}
          icon={FileText}
          title={hasFilters ? "Ei tiliotteita näillä suodattimilla" : "Ei tiliotteita vielä"}
          body={hasFilters ? "Kokeile väljempää hakua." : "Tuo ensimmäinen tiliote tiedostona yllä."}
        />
      ) : (
        <div className="space-y-3">
          <Section>
            {visibleStatements.map((s) => {
              const relevant = s.transactions.filter(
                (t) => t.type !== "oma_siirto" && t.type !== "palkka"
              ).length;
              const linked = s.transactions.filter(
                (t) => t.matchStatus === "confirmed"
              ).length;
              const missing = s.transactions.filter(
                (t) =>
                  t.type !== "oma_siirto" &&
                  t.type !== "palkka" &&
                  t.matchStatus !== "confirmed" &&
                  t.matchStatus !== "ignored"
              ).length;
              const secondary = [
                formatMonth(s.periodMonth),
                s.bankAccount ? s.bankAccount.name : "Ei pankkitiliä",
                `${s.totals.txCount} tapahtumaa`,
                relevant > 0 ? `${linked}/${relevant} linkitetty` : null,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <ListRow
                  key={s.id}
                  href={detailHref("statement", s.id, listParams())}
                  title={s.fileName}
                  secondary={secondary}
                  amount={formatEurSigned(s.totals.net)}
                  amountTone={s.totals.net >= 0 ? "positive" : "default"}
                  ariaLabel={`${s.fileName}, ${secondary}, ${formatEurSigned(s.totals.net)}${missing > 0 ? `, ${missing} puuttuu` : ""}`}
                  trailing={
                    (s.fileType === "enablebanking" || missing > 0) && (
                      <div className="flex items-center gap-1.5">
                        {s.fileType === "enablebanking" && <StatusTag tone="accent">Pankkiyhteys</StatusTag>}
                        {missing > 0 && <StatusTag tone="warning">{missing} puuttuu</StatusTag>}
                      </div>
                    )
                  }
                />
              );
            })}
          </Section>
          {filteredStatements.length > RECENT_LIMIT && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => setShowAllStatements((v) => !v)}
            >
              {showAllStatements ? "Näytä vähemmän" : `Katso kaikki (${filteredStatements.length})`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
