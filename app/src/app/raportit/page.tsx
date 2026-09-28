"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LoadingState } from "@/components/AsyncState";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { buttonClass, controlClass } from "@/components/control-styles";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Card, Icon, IconTile, KeyValueList, ListRow, PageTitle, Section } from "@/components/ds";
import { formatEur, formatMonthShort } from "@/lib/format";
import { receiptDrillHref } from "@/lib/report-drill";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";

// Extends a small inline text link's touch target to >=44px tall without
// growing what's actually drawn (same trick as kirjanpito/alv/page.tsx's
// own HIT44, with a slightly bigger inset: these rows' ~19px text line
// needs +13px each side, not +12px, to actually clear 44px).
const HIT44 = "relative before:absolute before:inset-x-0 before:-inset-y-[13px] before:content-['']";

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

/** The small chevron control under the page title (spec §10), same shape as Koti's month switcher. */
function YearSwitcher({ year, currentYear, onChange }: { year: number; currentYear: number; onChange: (next: number) => void }) {
  return (
    <div className="-mt-3 mb-5 flex items-center gap-1 px-1">
      <button
        type="button"
        aria-label="Edellinen vuosi"
        onClick={() => onChange(year - 1)}
        className="active-press relative flex h-8 w-8 items-center justify-center rounded-full text-ink-2 before:absolute before:-inset-2 before:content-['']"
      >
        <Icon icon={ChevronLeft} size="inline" />
      </button>
      <span className="min-w-[4ch] text-center text-[13px] tabular-nums text-ink-2">{year}</span>
      <button
        type="button"
        aria-label="Seuraava vuosi"
        onClick={() => onChange(year + 1)}
        disabled={year >= currentYear}
        className="active-press relative flex h-8 w-8 items-center justify-center rounded-full text-ink-2 disabled:opacity-30 before:absolute before:-inset-2 before:content-['']"
      >
        <Icon icon={ChevronRight} size="inline" />
      </button>
    </div>
  );
}

/** Category keys are stored lower-case ("tarvikkeet"); a list title starts with a capital. */
function sentenceCase(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase("fi-FI") + text.slice(1) : text;
}

/**
 * Same markup/classes as `ListRow`, but a real `<a>` instead of `next/link`'s
 * `Link`: these hrefs are file downloads (Content-Disposition: attachment),
 * and a client-side route transition would swallow that instead of letting
 * the browser save the file.
 */
function DownloadRow({ href, title }: { href: string; title: string }) {
  return (
    <div className="relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left">
      <a href={href} aria-label={title} className="row-link active-press absolute inset-0" />
      <IconTile>
        <Icon icon={Download} />
      </IconTile>
      <span className="pointer-events-none min-w-0 flex-1 text-[15px] font-medium text-ink">{title}</span>
    </div>
  );
}

export default function ReportsPage() {
  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = usePersistedState("raportit.year", currentYear);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [report, setReport] = useState<Report | null>(
    () => readPageCache<Report>(`report:${currentYear}`)
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    () => (readPageCache<Report>(`report:${currentYear}`) ? "ready" : "loading")
  );
  const [message, setMessage] = useState<string | null>(null);
  const [packageMonth, setPackageMonth] = useState(`${currentYear}-01`);

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
      setLoadFailure(null);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setMessage(errorMessage(error, "Raportin haku epäonnistui"));
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [year]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  useScrollRestoration("raportit", status === "ready");

  return (
    <>
      <div className="space-y-6 pb-6">
        <PageTitle title="Raportit" subtitle="Tuloslaskelma kuukausittain ja tiedot ulos kirjanpitäjälle." />
        <YearSwitcher year={year} currentYear={currentYear} onChange={setYear} />

        {loadFailure != null && status === "ready" && (
          <StaleBanner
            fetchedAt={pageCacheFetchedAt(`report:${year}`)}
            onRetry={() => void load()}
          />
        )}
        {status === "loading" && <LoadingState label="Lasketaan raporttia…" />}
        {status === "error" && (
          <ConnectionNotice
            error={loadFailure}
            fallback={message || "Raportin haku epäonnistui"}
            onRetry={() => void load()}
          />
        )}

        {status === "ready" && report && (
          <>
            <section className="mt-6 first:mt-0">
              <div className="mb-2 flex items-baseline justify-between gap-3 px-1 text-[13px] text-ink-2">
                <h2 className="font-normal">Tulos</h2>
              </div>
              <KeyValueList
                rows={[
                  {
                    label: "Tulos (veroton)",
                    value: (
                      <span className={report.total.profitNet < 0 ? "text-danger" : undefined}>
                        {formatEur(report.total.profitNet)}
                      </span>
                    ),
                  },
                  {
                    label: "Tulot",
                    value: (
                      <Link href={receiptDrillHref({ type: "tulo" })} aria-label="Avaa tulokuitit" className={`text-accent ${HIT44}`}>
                        {formatEur(report.total.incomeNet)}
                      </Link>
                    ),
                  },
                  {
                    label: "Menot",
                    value: (
                      <Link href={receiptDrillHref({ type: "meno" })} aria-label="Avaa menokuitit" className={`text-accent ${HIT44}`}>
                        {formatEur(report.total.expenseNet)}
                      </Link>
                    ),
                  },
                  { label: "Kuitteja", value: String(report.total.receiptCount) },
                  ...(report.total.missingVatCount > 0
                    ? [
                        {
                          label: "Ilman ALV-erittelyä",
                          value: <span className="text-warning">{report.total.missingVatCount}</span>,
                        },
                      ]
                    : []),
                  ...(report.undatedCount > 0
                    ? [{ label: "Ilman päivää", value: <span className="text-warning">{report.undatedCount}</span> }]
                    : []),
                ]}
              />
            </section>

            <section className="mt-6 first:mt-0">
              <div className="mb-2 flex items-baseline justify-between gap-3 px-1 text-[13px] text-ink-2">
                <h2 className="font-normal">Kuukaudet</h2>
              </div>
              {report.months.length === 0 ? (
                <p className="rounded-card border border-line bg-surface px-4 py-4 text-[15px] text-ink-2">
                  Ei kirjauksia tälle vuodelle.
                </p>
              ) : (
                <KeyValueList
                  rows={report.months.map((month) => ({
                    label: formatMonthShort(month.month!),
                    value: (
                      <Link
                        href={receiptDrillHref({ month: month.month })}
                        aria-label={`Avaa kuitit ${formatMonthShort(month.month!)}`}
                        className={`${month.profitNet < 0 ? "text-danger" : "text-accent"} ${HIT44}`}
                      >
                        {formatEur(month.profitNet)}
                      </Link>
                    ),
                  }))}
                />
              )}
            </section>

            <Section title="Menot kategorioittain">
              {report.total.expenseByCategory.length === 0 ? (
                <p className="px-4 py-4 text-[15px] text-ink-2">Ei menoja tällä jaksolla.</p>
              ) : (
                report.total.expenseByCategory.map((row) => (
                  <ListRow
                    key={row.category}
                    href={receiptDrillHref({ type: "meno", category: row.category })}
                    ariaLabel={`Avaa kuitit: ${row.category}`}
                    title={sentenceCase(row.category)}
                    secondary={`${row.count} ${row.count === 1 ? "kuitti" : "kuittia"} · brutto ${formatEur(row.gross)}`}
                    amount={formatEur(row.net)}
                  />
                ))
              )}
            </Section>

            {report.total.incomeByCategory.length > 0 && (
              <Section title="Tulot kategorioittain">
                {report.total.incomeByCategory.map((row) => (
                  <ListRow
                    key={row.category}
                    href={receiptDrillHref({ type: "tulo", category: row.category })}
                    ariaLabel={`Avaa kuitit: ${row.category}`}
                    title={sentenceCase(row.category)}
                    amount={formatEur(row.net)}
                  />
                ))}
              </Section>
            )}

            <Card className="space-y-3">
              <div>
                <p className="text-[15px] font-medium text-ink">Kirjanpitopaketti</p>
                <p className="text-[13px] text-ink-2">
                  Zip kaudelta: tuloslaskelma, ALV, CSV, kohdistukset ja tositteet.
                </p>
              </div>
              <div className="flex gap-2">
                <select
                  aria-label="Paketin kuukausi"
                  className={`${controlClass} flex-1`}
                  value={packageMonth.startsWith(`${year}-`) ? packageMonth : `${year}-01`}
                  onChange={(event) => setPackageMonth(event.target.value)}
                >
                  {Array.from({ length: 12 }, (_, index) => {
                    const month = `${year}-${String(index + 1).padStart(2, "0")}`;
                    return (
                      <option key={month} value={month}>
                        {formatMonthShort(month)}
                      </option>
                    );
                  })}
                </select>
                <a
                  href={`/api/export/package?month=${packageMonth.startsWith(`${year}-`) ? packageMonth : `${year}-01`}`}
                  className={buttonClass("primary", "shrink-0")}
                >
                  Lataa zip
                </a>
              </div>
            </Card>

            <Section title="Vie CSV-tiedostona">
              {EXPORTS.map((entry) => (
                <DownloadRow key={entry.type} href={`/api/export?type=${entry.type}`} title={entry.label} />
              ))}
            </Section>
          </>
        )}
      </div>
    </>
  );
}
