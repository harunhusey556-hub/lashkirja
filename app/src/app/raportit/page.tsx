"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatEur, formatMonthShort } from "@/lib/format";
import { readPageCache, writePageCache } from "@/lib/page-cache";

interface CategoryRow {
  category: string;
  gross: number;
  vat: number;
  net: number;
  count: number;
}

interface Period {
  month: string | null;
  incomeGross: number;
  incomeNet: number;
  expenseGross: number;
  expenseNet: number;
  profitNet: number;
  profitGross: number;
  incomeByCategory: CategoryRow[];
  expenseByCategory: CategoryRow[];
  receiptCount: number;
  missingVatCount: number;
  uncategorisedCount: number;
}

interface Report {
  from: string;
  to: string;
  total: Period;
  months: Period[];
  undatedCount: number;
}

const EXPORTS = [
  { type: "receipts", label: "Kuitit" },
  { type: "transactions", label: "Tilitapahtumat" },
  { type: "invoices", label: "Myyntilaskut" },
  { type: "purchase-invoices", label: "Ostolaskut" },
  { type: "customers", label: "Asiakkaat" },
] as const;

export default function ReportsPage() {
  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(currentYear);
  const [report, setReport] = useState<Report | null>(
    () => readPageCache<Report>(`report:${currentYear}`)
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    () => (readPageCache<Report>(`report:${currentYear}`) ? "ready" : "loading")
  );
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Show the cached year immediately and refresh it silently; a year that
    // has never been computed still gets the loading state.
    const cached = readPageCache<Report>(`report:${year}`);
    if (cached) {
      setReport(cached);
      setStatus("ready");
    } else {
      setStatus("loading");
    }
    try {
      const response = await apiFetch(
        `/api/reports/profit-loss?from=${year}-01&to=${year}-12`,
        { credentials: "include" }
      );
      const data = await readJson<Report>(response, "Raportin haku epäonnistui");
      writePageCache(`report:${year}`, data);
      setReport(data);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setMessage(errorMessage(error, "Raportin haku epäonnistui"));
      setStatus("error");
    }
  }, [year]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  const maxMonthValue = report
    ? Math.max(
        1,
        ...report.months.map((month) => Math.max(month.incomeGross, month.expenseGross))
      )
    : 1;

  return (
    <>
      <div className="space-y-6 pb-6">
        <header className="space-y-2">
          <h2 className="text-2xl font-semibold text-charcoal tracking-tight">Raportit</h2>
          <p className="text-sm text-warm-gray leading-relaxed">
            Tuloslaskelma kuukausittain ja tiedot ulos kirjanpitäjälle.
          </p>
        </header>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setYear((value) => value - 1)}
            className="min-h-11 px-4 py-2 rounded-xl border border-warm-gray-light/60 text-sm"
            aria-label="Edellinen vuosi"
          >
            ←
          </button>
          <span className="text-base font-medium text-charcoal">{year}</span>
          <button
            type="button"
            onClick={() => setYear((value) => value + 1)}
            disabled={year >= currentYear}
            className="min-h-11 px-4 py-2 rounded-xl border border-warm-gray-light/60 text-sm disabled:opacity-40"
            aria-label="Seuraava vuosi"
          >
            →
          </button>
        </div>

        {status === "loading" && <LoadingState label="Lasketaan raporttia…" />}
        {status === "error" && (
          <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
        )}

        {status === "ready" && report && (
          <>
            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
              <p className="text-sm text-warm-gray">Tulos (veroton)</p>
              <p
                className={`text-3xl font-semibold tracking-tight ${
                  report.total.profitNet < 0 ? "text-danger" : "text-charcoal"
                }`}
              >
                {formatEur(report.total.profitNet)}
              </p>
              <div className="grid grid-cols-2 gap-3 pt-1 text-sm">
                <div>
                  <p className="text-warm-gray text-xs">Tulot</p>
                  <p className="text-charcoal font-medium">{formatEur(report.total.incomeNet)}</p>
                </div>
                <div>
                  <p className="text-warm-gray text-xs">Menot</p>
                  <p className="text-charcoal font-medium">{formatEur(report.total.expenseNet)}</p>
                </div>
              </div>
              <p className="text-xs text-warm-gray">
                {report.total.receiptCount} kuittia
                {report.total.missingVatCount > 0 && (
                  <span className="text-warning">
                    {" "}
                    · {report.total.missingVatCount} ilman ALV-erittelyä (mukana bruttona)
                  </span>
                )}
                {report.undatedCount > 0 && (
                  <span className="text-warning"> · {report.undatedCount} ilman päivää</span>
                )}
              </p>
            </section>

            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
              <p className="text-base font-medium text-charcoal">Kuukaudet</p>
              {report.months.length === 0 ? (
                <p className="text-sm text-warm-gray">Ei kirjauksia tälle vuodelle.</p>
              ) : (
                <ul className="space-y-2">
                  {report.months.map((month) => (
                    <li key={month.month} className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-charcoal">{formatMonthShort(month.month!)}</span>
                        <span
                          className={
                            month.profitNet < 0 ? "text-danger font-medium" : "text-charcoal font-medium"
                          }
                        >
                          {formatEur(month.profitNet)}
                        </span>
                      </div>
                      <div className="flex gap-1 h-2" aria-hidden>
                        <div
                          className="bg-success/60 rounded-full"
                          style={{ width: `${(month.incomeGross / maxMonthValue) * 50}%` }}
                        />
                        <div
                          className="bg-accent/50 rounded-full"
                          style={{ width: `${(month.expenseGross / maxMonthValue) * 50}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
              <p className="text-base font-medium text-charcoal">Menot kategorioittain</p>
              {report.total.expenseByCategory.length === 0 ? (
                <p className="text-sm text-warm-gray">Ei menoja tällä jaksolla.</p>
              ) : (
                <ul className="space-y-2">
                  {report.total.expenseByCategory.map((row) => (
                    <li key={row.category} className="flex justify-between text-sm">
                      <div className="min-w-0">
                        <p className="text-charcoal truncate">{row.category}</p>
                        <p className="text-xs text-warm-gray">{row.count} kuittia</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-charcoal">{formatEur(row.net)}</p>
                        <p className="text-xs text-warm-gray">brutto {formatEur(row.gross)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {report.total.incomeByCategory.length > 0 && (
              <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
                <p className="text-base font-medium text-charcoal">Tulot kategorioittain</p>
                <ul className="space-y-2">
                  {report.total.incomeByCategory.map((row) => (
                    <li key={row.category} className="flex justify-between text-sm">
                      <span className="text-charcoal truncate">{row.category}</span>
                      <span className="text-charcoal shrink-0">{formatEur(row.net)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
              <p className="text-base font-medium text-charcoal">Vie CSV-tiedostona</p>
              <p className="text-xs text-warm-gray">
                Puolipiste-eroteltu, avautuu suoraan Exceliin.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {EXPORTS.map((entry) => (
                  <a
                    key={entry.type}
                    href={`/api/export?type=${entry.type}`}
                    className="text-center text-sm font-medium px-3 py-2.5 rounded-xl border border-warm-gray-light/60 text-charcoal"
                  >
                    {entry.label}
                  </a>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
