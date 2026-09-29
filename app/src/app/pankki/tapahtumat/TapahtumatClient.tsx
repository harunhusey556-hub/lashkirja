"use client";

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
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { chooseDocuments, isNativeShell } from "@/lib/native-pick";
import { Button, controlClass } from "@/components/ui";
import { ListRow, PageTitle, Section, StatusTag } from "@/components/ds";
import { detailHref } from "@/lib/routes";

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
  const [showAllStatements, setShowAllStatements] = usePersistedState(
    "tiliotteet.showAllStatements",
    false
  );
  const [loadError, setLoadError] = useState("");
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
      setLoadError("");
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadError(errorMessage(error, "Tiliotteiden lataus epäonnistui"));
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
        router.push(detailHref("statement", data.statement.id, Object.fromEntries(searchParams.entries())));
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
    const picked = await chooseDocuments([
      "application/pdf",
      "text/xml",
      "application/xml",
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
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
      <PageTitle title="Tapahtumat" subtitle="Tapahtumat tulevat yhdistetystä pankista." />

      <div className="space-y-3">
        <div>
          <label htmlFor="statement-search" className="mb-1.5 block text-[13px] font-normal text-ink-2">
            Haku
          </label>
          <input
            id="statement-search"
            value={query}
            onChange={(event) => {
              replaceQuery({ q: event.target.value });
              setShowAllStatements(false);
            }}
            placeholder="Tiedosto tai tili"
            className={controlClass}
          />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="min-w-0 flex-1">
            <label htmlFor="statement-month-filter" className="mb-1.5 block text-[13px] font-normal text-ink-2">
              Kuukausi
            </label>
            <select
              id="statement-month-filter"
              value={monthFilter}
              onChange={(event) => {
                replaceQuery({ month: event.target.value });
                setShowAllStatements(false);
              }}
              className={controlClass}
            >
              <option value="">Kaikki</option>
              {months.map((month) => (
                <option key={month} value={month}>
                  {formatMonth(month)}
                </option>
              ))}
            </select>
          </div>
          {accounts.length > 0 && (
            <div className="min-w-0 flex-1">
              <label htmlFor="statement-account-filter" className="mb-1.5 block text-[13px] font-normal text-ink-2">
                Tili
              </label>
              <select
                id="statement-account-filter"
                value={accountFilter}
                onChange={(event) => {
                  replaceQuery({ account: event.target.value });
                  setShowAllStatements(false);
                }}
                className={controlClass}
              >
                <option value="">Kaikki</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <Section title="Tuo tiliote tiedostona">
        <div className="space-y-4 px-4 py-4">
          <p className="text-[13px] text-ink-2">PDF, XML, XLSX tai CSV</p>

          {accounts.length > 0 && (
            <div>
              <label htmlFor="statement-target-account" className="mb-1.5 block text-[13px] font-normal text-ink-2">
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
              className={`text-[13px] ${
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

      {loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => {
            setLoadError("");
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
          title={hasFilters ? "Ei tiliotteita näillä suodattimilla" : "Ei tiliotteita vielä"}
          body={hasFilters ? "Kokeile väljempää hakua." : "Tuo tiedosto tai hae tapahtumat pankista yllä."}
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
                  href={detailHref("statement", s.id, Object.fromEntries(searchParams.entries()))}
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
