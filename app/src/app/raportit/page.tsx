"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { buttonClass, controlClass } from "@/components/control-styles";
import { AuthedFileLink } from "@/components/AuthedFileLink";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import {
  Card,
  Icon,
  IconTile,
  KeyValueList,
  ListRow,
  PageTitle,
  Section,
  Skeleton,
  SkeletonCard,
  SkeletonGroup,
  useSkeletonFade,
} from "@/components/ds";
import { formatEur, formatMonthShort } from "@/lib/format";
import { receiptDrillHref } from "@/lib/report-drill";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
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
  invoiceCount?: number;
  creditNoteCount?: number;
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
  { type: "profit-loss", label: "Tuloslaskelma" },
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
      <span className="min-w-[4ch] text-center text-caption tabular-nums text-ink-2">{year}</span>
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

/** The report at its final layout while the year is computed (L1, SALES-19). */
function ReportSkeleton() {
  return (
    <SkeletonGroup label="Lasketaan raporttia" className="space-y-6">
      <div>
        <Skeleton tone="soft" className="mx-1 mb-3 h-3 w-12" />
        <SkeletonCard className="space-y-4">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex justify-between gap-6">
              <Skeleton tone="soft" className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
            </div>
          ))}
        </SkeletonCard>
      </div>
      <div>
        <Skeleton tone="soft" className="mx-1 mb-3 h-3 w-20" />
        <SkeletonCard className="space-y-5">
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-2">
              <div className="flex justify-between gap-6">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton tone="soft" className="h-3 w-2/3" />
            </div>
          ))}
        </SkeletonCard>
      </div>
    </SkeletonGroup>
  );
}

/** Category keys are stored lower-case ("tarvikkeet"); a list title starts with a capital. */
function sentenceCase(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase("fi-FI") + text.slice(1) : text;
}

/**
 * Same markup/classes as `ListRow`, but a real, authenticated file link
 * instead of `next/link`'s `Link`: these hrefs are file downloads
 * (Content-Disposition: attachment), and a client-side route transition
 * would swallow that instead of letting the browser (or, on mobile, the
 * share sheet) save the file.
 */
function DownloadRow({
  href,
  title,
  fallbackName,
}: {
  href: string;
  title: string;
  fallbackName: string;
}) {
  return (
    <div className="relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left">
      <AuthedFileLink
        href={href}
        fallbackName={fallbackName}
        title={title}
        className="peer row-link active-press absolute inset-0"
      >
        {null}
      </AuthedFileLink>
      <IconTile>
        <Icon icon={Download} />
      </IconTile>
      <span className="pointer-events-none min-w-0 flex-1 text-body font-medium text-ink">{title}</span>
      {/* Progress while the file is fetched for the share sheet (SALES-22). */}
      <span
        aria-hidden
        className="pointer-events-none h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink-2 opacity-0 peer-data-[busy=true]:opacity-100"
      />
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
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton.
  const lateReport = useCacheAfterBoot<Report>(`report:${year}`);
  const [appliedLateReport, setAppliedLateReport] = useState<Report | null>(null);
  if (lateReport && lateReport !== appliedLateReport && status === "loading") {
    setAppliedLateReport(lateReport);
    setReport(lateReport);
    setStatus("ready");
  }
  const fade = useSkeletonFade(status === "loading");

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

  const packagePeriod = packageMonth.startsWith(`${year}`) ? packageMonth : `${year}-01`;

  return (
    <>
      <div className="space-y-6">
        <PageTitle title="Raportit" subtitle="Tuloslaskelma kuukausittain ja tiedot ulos kirjanpitäjälle." />
        <YearSwitcher year={year} currentYear={currentYear} onChange={setYear} />

        {loadFailure != null && status === "ready" && (
          <StaleBanner
            fetchedAt={pageCacheFetchedAt(`report:${year}`)}
            onRetry={() => void load()}
          />
        )}
        {status === "loading" && <ReportSkeleton />}
        {status === "error" && (
          <ConnectionNotice
            error={loadFailure}
            fallback={message || "Raportin haku epäonnistui"}
            onRetry={() => void load()}
          />
        )}

        {status === "ready" && report && (
          <div className={`space-y-6 ${fade}`}>
            <section className="mt-6 first:mt-0">
              <div className="mb-2 flex items-baseline justify-between gap-3 px-1 text-caption text-ink-2">
                <h2 className="font-normal">Tulos</h2>
              </div>
              <KeyValueList
                rows={[
                  {
                    label: "Tulos ilman ALV:ta",
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

            {/* What the figures are built from, and on which basis (SALES-01, SALES-37). */}
            <p className="-mt-3 px-1 text-caption leading-relaxed text-ink-2">
              {report.total.receiptCount} {report.total.receiptCount === 1 ? "kuitti" : "kuittia"} ja{" "}
              {(report.total.invoiceCount ?? 0) + (report.total.creditNoteCount ?? 0)} myyntilaskua. Laskut
              lasketaan laskun päivän mukaan, hyvityslasku vähentää myyntiä omalla kuukaudellaan.
            </p>

            {report.months.length === 0 ? (
              <section className="mt-6 first:mt-0">
                <div className="mb-2 px-1 text-caption text-ink-2">
                  <h2 className="font-normal">Kuukaudet</h2>
                </div>
                <p className="rounded-card border border-line bg-surface px-4 py-4 text-body text-ink-2">
                  Ei kirjauksia tälle vuodelle.
                </p>
              </section>
            ) : (
              <Section title="Kuukaudet">
                {report.months.map((month) => (
                  <ListRow
                    key={month.month}
                    href={receiptDrillHref({ month: month.month })}
                    title={formatMonthShort(month.month!)}
                    amount={formatEur(month.profitNet)}
                    secondary={`Tulot ${formatEur(month.incomeNet)} · Menot ${formatEur(month.expenseNet)}`}
                    ariaLabel={`${formatMonthShort(month.month!)}, tulos ${formatEur(month.profitNet)}, tulot ${formatEur(month.incomeNet)}, menot ${formatEur(month.expenseNet)}`}
                  />
                ))}
              </Section>
            )}

            <Section title="Menot kategorioittain">
              {report.total.expenseByCategory.length === 0 ? (
                <p className="px-4 py-4 text-body text-ink-2">Ei menoja tällä jaksolla.</p>
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
                    href={
                      row.category === "Myyntilaskut"
                        ? "/laskut"
                        : row.category === "Hyvityslaskut"
                          ? "/laskut?status=credited"
                          : receiptDrillHref({ type: "tulo", category: row.category })
                    }
                    ariaLabel={`Avaa: ${row.category}`}
                    title={sentenceCase(row.category)}
                    amount={formatEur(row.net)}
                  />
                ))}
              </Section>
            )}

            <Card className="space-y-3">
              <div>
                <p className="text-body font-medium text-ink">Kirjanpitopaketti</p>
                <p className="text-caption text-ink-2">
                  Zip kuukaudelta, neljännekseltä tai koko vuodelta: tuloslaskelma, ALV, CSV,
                  kohdistukset ja tositteet.
                </p>
              </div>
              <div className="flex gap-2">
                <select
                  aria-label="Paketin kausi"
                  className={`${controlClass} min-w-0 flex-1`}
                  value={packagePeriod}
                  onChange={(event) => setPackageMonth(event.target.value)}
                >
                  <optgroup label="Kuukausi">
                    {Array.from({ length: 12 }, (_, index) => {
                      const month = `${year}-${String(index + 1).padStart(2, "0")}`;
                      return (
                        <option key={month} value={month}>
                          {formatMonthShort(month)}
                        </option>
                      );
                    })}
                  </optgroup>
                  <optgroup label="Neljännes">
                    {[1, 2, 3, 4].map((quarter) => (
                      <option key={quarter} value={`${year}-Q${quarter}`}>
                        {`Q${quarter}/${year}`}
                      </option>
                    ))}
                  </optgroup>
                  <option value={String(year)}>{`Koko vuosi ${year}`}</option>
                </select>
                <AuthedFileLink
                  href={`/api/export/package?month=${packagePeriod}`}
                  fallbackName={`kirjanpito-${packagePeriod}.zip`}
                  title="Kirjanpitopaketti"
                  className={buttonClass("primary", "shrink-0 aria-busy:opacity-60")}
                >
                  Lataa zip
                </AuthedFileLink>
              </div>
            </Card>

            {/* The CSVs follow the year on screen (SALES-21); customers are not per period. */}
            <Section title={`Vie CSV-tiedostona, ${year}`}>
              {EXPORTS.map((entry) => (
                <DownloadRow
                  key={entry.type}
                  href={
                    entry.type === "customers"
                      ? "/api/export?type=customers"
                      : `/api/export?type=${entry.type}&year=${year}`
                  }
                  title={entry.label}
                  fallbackName={entry.type === "customers" ? "asiakkaat.csv" : `${entry.type}-${year}.csv`}
                />
              ))}
            </Section>
          </div>
        )}
      </div>
    </>
  );
}
