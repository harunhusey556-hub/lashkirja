"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { BANK_LINKS, WorkspaceLinks, linksWithActive } from "@/components/WorkspaceLinks";
import { readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";

const RECENT_LIMIT = 5;

interface BankAccountOption {
  id: string;
  name: string;
  bankName: string | null;
  isDefault: boolean;
}

export default function TiliotteetPage() {
  const router = useRouter();
  const [statements, setStatements] = useState<StatementData[]>(
    () => readPageCache<StatementData[]>("statements") ?? []
  );
  const [uploading, setUploading] = useState(false);
  const [bankSyncing, setBankSyncing] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [loading, setLoading] = useState(
    () => readPageCache<StatementData[]>("statements") === null
  );
  // Persisted so back-navigation restores the active filter/tab instead of
  // resetting to the defaults.
  const [monthFilter, setMonthFilter] = usePersistedState("tiliotteet.monthFilter", "");
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

  async function handleBankSync() {
    if (bankSyncing || uploading) return;
    setBankSyncing(true);
    setUploadMsg("Haetaan tapahtumia pankista...");
    try {
      const listResponse = await fetch("/api/bank/connections");
      const list = await readJson<{
        ready?: boolean;
        connections?: Array<{
          id: string;
          status: string;
          accounts: Array<{ inScope: boolean }>;
        }>;
      }>(listResponse, "Pankkiyhteyksien lataus epäonnistui");
      const targets = (list.connections || []).filter(
        (connection) =>
          connection.status === "active" &&
          connection.accounts.some((account) => account.inScope)
      );
      if (!list.ready || targets.length === 0) {
        setUploadMsg("");
        router.push("/asetukset#pankkiyhteys");
        return;
      }
      let imported = 0;
      let statementId: string | null = null;
      for (const connection of targets) {
        const response = await fetch(`/api/bank/connections/${connection.id}/sync`, {
          method: "POST",
        });
        const data = await readJson<{ imported: number; statementId: string | null }>(
          response,
          "Pankin haku epäonnistui"
        );
        imported += data.imported;
        if (data.statementId) statementId = data.statementId;
      }
      if (statementId && imported > 0) {
        router.push(`/tiliotteet/${statementId}`);
        return;
      }
      setUploadMsg(imported > 0 ? `${imported} uutta tapahtumaa` : "Ei uusia tapahtumia");
      await loadStatements();
    } catch (error: unknown) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setUploadMsg(`Virhe: ${errorMessage(error, "Pankin haku epäonnistui")}`);
    } finally {
      setBankSyncing(false);
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadMsg("Käsitellään tiliotetta...");
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (targetAccountId) fd.append("bankAccountId", targetAccountId);

      const res = await fetch("/api/statements", { method: "POST", body: fd });
      const data = await readJson<{
        count: number;
        statement?: { id?: string };
      }>(res, "Tiliotteen käsittely epäonnistui");
      setUploadMsg(`${data.count} tapahtumaa löydetty`);
      if (data.statement?.id) {
        router.push(`/tiliotteet/${data.statement.id}`);
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

  const months = [
    ...new Set(
      statements.map((s) => s.periodMonth).filter((m): m is string => !!m)
    ),
  ].sort().reverse();

  const filteredStatements = monthFilter
    ? statements.filter((s) => s.periodMonth === monthFilter)
    : statements;
  const visibleStatements = showAllStatements
    ? filteredStatements
    : filteredStatements.slice(0, RECENT_LIMIT);

  return (
    <>
      <div className="space-y-8 pb-6">
        <header className="space-y-2">
          <h2 className="text-2xl font-semibold text-charcoal tracking-tight">
            Tiliotteet
          </h2>
          <p className="text-sm text-warm-gray leading-relaxed">
            Tuo tiliote tiedostona tai hae tapahtumat yhdistetystä pankista.
          </p>
          <WorkspaceLinks items={linksWithActive(BANK_LINKS, "/tiliotteet")} />
        </header>

        <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-5">
          <div className="space-y-1">
            <p className="text-base font-medium text-charcoal">
              Uusi tiliote
            </p>
            <p className="text-sm text-warm-gray leading-relaxed">
              PDF, XML, XLSX tai CSV
            </p>
          </div>

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
                className="w-full text-sm px-4 py-3 rounded-xl border border-warm-gray-light/60 bg-white"
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

          <div className="grid grid-cols-1 gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || bankSyncing}
              className="touch-target w-full min-h-12 rounded-2xl bg-accent text-sm font-medium text-white transition-colors hover:bg-accent-dark disabled:opacity-50"
            >
              {uploading ? "Käsitellään..." : "Tuo tiedosto"}
            </button>
            <button
              type="button"
              onClick={() => void handleBankSync()}
              disabled={uploading || bankSyncing}
              className="touch-target w-full min-h-12 rounded-2xl border border-warm-gray-light text-sm font-medium text-charcoal transition-colors hover:bg-cream disabled:opacity-50"
            >
              {bankSyncing ? "Haetaan pankista..." : "Hae pankista"}
            </button>
          </div>

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
              {(uploading || bankSyncing) && (
                <span
                  className="inline-block w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none mr-2 align-middle"
                  aria-hidden="true"
                />
              )}
              {uploadMsg}
            </p>
          )}
        </section>

        {months.length > 1 && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-1">
            <label
              htmlFor="statement-month-filter"
              className="text-sm font-medium text-charcoal"
            >
              Kuukausi
            </label>
            <select
              id="statement-month-filter"
              value={monthFilter}
              onChange={(e) => {
                setMonthFilter(e.target.value);
                setShowAllStatements(false);
              }}
              className="text-sm px-4 py-2.5 rounded-xl border border-warm-gray-light/60 bg-white min-w-[10rem]"
            >
              <option value="">Kaikki</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {formatMonth(m)}
                </option>
              ))}
            </select>
          </div>
        )}

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
          <div className="text-center py-16 text-sm text-warm-gray leading-relaxed">
            Ei tiliotteita vielä
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
                  href={`/tiliotteet/${s.id}`}
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
