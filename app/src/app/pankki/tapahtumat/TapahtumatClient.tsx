"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ErrorState, SkeletonList } from "@/components/AsyncState";
import StatementSummaryCards from "@/components/StatementSummaryCards";
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
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { chooseDocuments, isNativeShell } from "@/lib/native-pick";

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
        router.push(`${`/pankki/tapahtumat/${data.statement.id}`}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`);
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

  return (
    <>
      <div className="space-y-8 pb-6">
        <p className="text-sm text-warm-gray leading-relaxed">
          Tapahtumat tulevat yhdistetystä pankista. Tiedoston tuonti on alla, jos tarvitset sen.
        </p>

        <div className="flex flex-col gap-2">
          <label htmlFor="statement-search" className="text-sm font-medium text-charcoal">
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
            className="min-h-12 rounded-xl border border-warm-gray-light/60 bg-white px-4 text-sm"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-charcoal">
              Kuukausi
              <select
                id="statement-month-filter"
                value={monthFilter}
                onChange={(event) => {
                  replaceQuery({ month: event.target.value });
                  setShowAllStatements(false);
                }}
                className="min-h-12 rounded-xl border border-warm-gray-light/60 bg-white px-4 text-sm font-normal"
              >
                <option value="">Kaikki</option>
                {months.map((month) => (
                  <option key={month} value={month}>
                    {formatMonth(month)}
                  </option>
                ))}
              </select>
            </label>
            {accounts.length > 0 && (
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium text-charcoal">
                Tili
                <select
                  id="statement-account-filter"
                  value={accountFilter}
                  onChange={(event) => {
                    replaceQuery({ account: event.target.value });
                    setShowAllStatements(false);
                  }}
                  className="min-h-12 rounded-xl border border-warm-gray-light/60 bg-white px-4 text-sm font-normal"
                >
                  <option value="">Kaikki</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        <details className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-5">
          <summary className="text-sm font-medium text-charcoal cursor-pointer min-h-11">
            Tuo tiliote tiedostona
          </summary>
          <p className="text-sm text-warm-gray leading-relaxed pt-3">PDF, XML, XLSX tai CSV</p>

          {accounts.length > 0 && (
            <div className="space-y-1.5">
              <label
                htmlFor="statement-target-account"
                className="text-sm font-medium text-charcoal"
              >
                Pankkitili
              </label>
              <select
                id="statement-target-account"
                value={targetAccountId}
                onChange={(e) => setTargetAccountId(e.target.value)}
                className="w-full min-h-12 min-w-0 text-sm px-4 rounded-xl border border-warm-gray-light/60 bg-white"
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

          <button
            type="button"
            onClick={() => void pickStatementFile()}
            disabled={uploading}
            className="touch-target w-full min-h-12 rounded-2xl border border-warm-gray-light text-sm font-medium text-charcoal transition-colors hover:bg-cream disabled:opacity-50 active-press"
          >
            {uploading ? "Käsitellään..." : "Tuo tiedosto"}
          </button>

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
              className={`text-sm leading-relaxed ${
                uploading
                  ? "text-warm-gray"
                  : uploadMsg.startsWith("Virhe")
                    ? "text-danger"
                    : "text-success"
              }`}
              role={uploadMsg.startsWith("Virhe") ? "alert" : "status"}
              aria-live="polite"
            >
              {uploading && (
                <span
                  className="inline-block w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none mr-2 align-middle"
                  aria-hidden="true"
                />
              )}
              {uploadMsg}
            </p>
          )}
        </details>

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
          <div className="text-center py-10 space-y-2">
            <p className="text-sm font-medium text-charcoal">Ei tiliotteita vielä</p>
            <p className="text-sm text-warm-gray leading-relaxed">
              Tuo tiedosto tai hae tapahtumat pankista yllä.
            </p>
          </div>
        ) : (
          <div className="space-y-4 list-stagger">
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

              return (
                <Link
                  key={s.id}
                  href={searchParams.toString() ? `/pankki/tapahtumat/${s.id}?${searchParams.toString()}` : `/pankki/tapahtumat/${s.id}`}
                  className="block bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm overflow-hidden hover:border-accent/20 hover:shadow-md transition-all"
                >
                  <div className="p-6 space-y-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-2">
                        <p className="text-base font-semibold text-charcoal leading-snug break-words">
                          {s.fileName}
                        </p>
                        {s.fileType === "enablebanking" && (
                          <p className="text-xs font-medium text-accent">Pankkiyhteys</p>
                        )}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-warm-gray">
                          <span>{formatMonth(s.periodMonth)}</span>
                          <span aria-hidden>·</span>
                          <span
                            className={s.bankAccount ? "" : "text-warning"}
                            title={s.bankAccount ? undefined : "Tiliotetta ei ole kohdistettu pankkitilille"}
                          >
                            {s.bankAccount ? s.bankAccount.name : "Ei pankkitiliä"}
                          </span>
                          <span aria-hidden>·</span>
                          <span>{s.totals.txCount} tapahtumaa</span>
                          {relevant > 0 && (
                            <>
                              <span aria-hidden>·</span>
                              <span>
                                {linked}/{relevant} linkitetty
                              </span>
                            </>
                          )}
                          {missing > 0 && (
                            <>
                              <span aria-hidden>·</span>
                              <span className="text-accent">
                                {missing} puuttuu
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <svg
                        className="w-5 h-5 shrink-0 text-warm-gray mt-0.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </div>

                    <StatementSummaryCards totals={s.totals} compact />
                  </div>
                </Link>
              );
            })}

            {filteredStatements.length > RECENT_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAllStatements((v) => !v)}
                className="w-full py-3 text-sm font-medium text-accent hover:text-accent-dark transition-colors"
              >
                {showAllStatements
                  ? "Näytä vähemmän"
                  : `Katso kaikki (${filteredStatements.length})`}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
