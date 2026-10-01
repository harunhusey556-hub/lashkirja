"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LoadingState } from "@/components/AsyncState";
import { PageHeader } from "@/components/PageHeader";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

import { formatEur } from "@/lib/format";
import { receiptDrillHref } from "@/lib/report-drill";
import { helsinkiMonthKey, helsinkiQuarterKey } from "@/lib/validation";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
interface SalesField {
  label: string;
  netSales: number;
  vat: number;
}

interface ALVData {
  vatRegistered: boolean;
  field301: SalesField;
  field302: SalesField;
  field303: SalesField;
  field309: { label: string; turnover: number };
  field307: { label: string; amount: number };
  field308: { label: string; amount: number; isRefund: boolean };
  review: { salesGross: number; purchasesGross: number; count: number };
  receiptCount: number;
  sources?: { receiptSalesVat: number; invoiceSalesVat: number; invoiceCount: number };
  excludedReceiptCount?: number;
  creditedInvoiceCount?: number;
}


const MONTHS = [
  "Tammikuu",
  "Helmikuu",
  "Maaliskuu",
  "Huhtikuu",
  "Toukokuu",
  "Kesäkuu",
  "Heinäkuu",
  "Elokuu",
  "Syyskuu",
  "Lokakuu",
  "Marraskuu",
  "Joulukuu",
];

export default function ALVRaporttiPage() {
  const now = new Date();
  const defaultPeriod = helsinkiMonthKey(now);

  const [periodType, setPeriodType] = usePersistedState<"month" | "quarter">("alv.periodType", "month");
  const [selectedMonth, setSelectedMonth] = usePersistedState("alv.month", defaultPeriod);
  const [selectedQuarter, setSelectedQuarter] = usePersistedState(
    "alv.quarter",
    helsinkiQuarterKey(now)
  );
  const [result, setResult] = useState<{
    period: string;
    data: ALVData;
  } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const period = periodType === "month" ? selectedMonth : selectedQuarter;

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("period");
    if (!raw) return;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
      setPeriodType("month");
      setSelectedMonth(raw);
    } else if (/^\d{4}-Q[1-4]$/.test(raw)) {
      setPeriodType("quarter");
      setSelectedQuarter(raw);
    }
    // The link's period wins over the last period the page remembered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch(`/api/alv?period=${period}`, { signal: controller.signal })
      .then((response) =>
        readJson<ALVData>(response, "ALV-raportin lataus epäonnistui")
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data.field301 || !data.field307 || !data.field308) {
          throw new Error("Palvelin palautti virheellisen ALV-raportin");
        }
        setLoadError(null);
        writePageCache(`alv:${period}`, data);
        setResult({ period, data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(error);
      });
    return () => controller.abort();
  }, [period, loadAttempt]);

  // A previously computed period paints instantly from the cache while the
  // fetch above recomputes it in the background.
  const data =
    result?.period === period
      ? result.data
      : readPageCache<ALVData>(`alv:${period}`);
  const loading = !data && !loadError;
  useScrollRestoration("alv", Boolean(data));

  function buildMonthOptions() {
    const opts: { value: string; label: string }[] = [];
    const year = Number(helsinkiMonthKey(now).slice(0, 4));
    for (let m = 0; m < 12; m++) {
      const val = `${year}-${String(m + 1).padStart(2, "0")}`;
      opts.push({ value: val, label: `${MONTHS[m]} ${year}` });
    }
    return opts;
  }

  function buildQuarterOptions() {
    const year = Number(helsinkiMonthKey(now).slice(0, 4));
    return [1, 2, 3, 4].map((q) => ({
      value: `${year}-Q${q}`,
      label: `Q${q} / ${year}`,
    }));
  }

  return (
    <>
      <div className="space-y-6">
        <PageHeader description="Kuukauden tai neljänneksen arvonlisävero." />

        {data && !data.vatRegistered && (
          <div className="bg-warning/10 rounded-2xl p-4 text-sm text-charcoal">
            <p className="font-medium">OmaVero-luonnos</p>
            <p className="mt-1">
              Et ole merkinnyt olevasi ALV-rekisterissä (Asetukset). Tämä
              raportti on vain arvio — ALV-ilmoitusta ei tarvitse antaa, jos
              et ole ALV-rekisterissä.
            </p>
          </div>
        )}

        <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setLoadError(null);
                setPeriodType("month");
              }}
              aria-pressed={periodType === "month"}
              className={`active-press min-h-12 flex-1 rounded-xl text-sm font-medium transition-colors ${
                periodType === "month"
                  ? "bg-accent text-white"
                  : "bg-white text-charcoal border border-warm-gray-light"
              }`}
            >
              Kuukausi
            </button>
            <button
              type="button"
              onClick={() => {
                setLoadError(null);
                setPeriodType("quarter");
              }}
              aria-pressed={periodType === "quarter"}
              className={`active-press min-h-12 flex-1 rounded-xl text-sm font-medium transition-colors ${
                periodType === "quarter"
                  ? "bg-accent text-white"
                  : "bg-white text-charcoal border border-warm-gray-light"
              }`}
            >
              Neljännes
            </button>
          </div>

          {periodType === "month" ? (
            <select
              aria-label="ALV-raportin kuukausi"
              value={selectedMonth}
              onChange={(e) => {
                setLoadError(null);
                setSelectedMonth(e.target.value);
              }}
              className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-white text-sm"
            >
              {buildMonthOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <select
              aria-label="ALV-raportin neljännes"
              value={selectedQuarter}
              onChange={(e) => {
                setLoadError(null);
                setSelectedQuarter(e.target.value);
              }}
              className="w-full min-h-12 min-w-0 px-3 rounded-xl border border-warm-gray-light bg-white text-sm"
            >
              {buildQuarterOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>

        {loadError != null && data ? (
          <StaleBanner
            fetchedAt={pageCacheFetchedAt(`alv:${period}`)}
            onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
          />
        ) : null}
        {loadError != null && !data ? (
          <ConnectionNotice
            error={loadError}
            fallback="ALV-raportin lataus epäonnistui"
            onRetry={() => {
              setLoadError(null);
              setLoadAttempt((attempt) => attempt + 1);
            }}
            compact
          />
        ) : loading ? (
          <LoadingState label="Ladataan ALV-raporttia..." compact />
        ) : data ? (
          <div className="space-y-3">
            <p className="text-xs text-warm-gray text-center">
              OmaVero-ilmoituksen kentät · {data.receiptCount} kuittia
              kaudella
              {data.sources && data.sources.invoiceCount > 0 && (
                <> · {data.sources.invoiceCount} myyntilaskua</>
              )}
            </p>

            {data.sources && data.sources.invoiceCount > 0 && (
              <div className="bg-blush/40 rounded-2xl p-4 text-sm text-charcoal">
                <p className="font-medium">Myynnin ALV kahdesta lähteestä</p>
                <p className="mt-1 text-xs text-warm-gray">
                  Kuiteista {formatEur(data.sources.receiptSalesVat)} · myyntilaskuista{" "}
                  {formatEur(data.sources.invoiceSalesVat)}. Laskut lasketaan laskun päivän
                  mukaan (suoriteperuste).
                  {data.excludedReceiptCount ? (
                    <>
                      {" "}
                      {data.excludedReceiptCount} kuittia jätettiin pois, koska sama
                      tilitapahtuma on jo kohdistettu laskulle.
                    </>
                  ) : null}
                  {data.creditedInvoiceCount ? (
                    <> {data.creditedInvoiceCount} hyvitettyä laskua ei ole mukana.</>
                  ) : null}
                </p>
              </div>
            )}

            {data.review.count > 0 && (
              <div className="bg-warning/10 rounded-2xl p-4 text-sm text-charcoal">
                <p className="font-medium">
                  {data.review.count} kuittia ilman ALV-erittelyä
                </p>
                <p className="mt-1 text-xs text-warm-gray">
                  Myynnit {formatEur(data.review.salesGross)} · Ostot{" "}
                  {formatEur(data.review.purchasesGross)} — lisää
                  ALV-tiedot kuiteille, jotta ne lasketaan mukaan.
                </p>
              </div>
            )}

            <OmaVeroField
              code="301"
              label="Vero kotimaan myynnistä 25,5 %"
              sales={data.field301.netSales}
              vat={data.field301.vat}
              href={receiptDrillHref({
                month: periodType === "month" ? period : null,
                type: "tulo",
              })}
            />
            <OmaVeroField
              code="302"
              label="Vero kotimaan myynnistä 13,5 %"
              sales={data.field302.netSales}
              vat={data.field302.vat}
            />
            <OmaVeroField
              code="303"
              label="Vero kotimaan myynnistä 10 %"
              sales={data.field303.netSales}
              vat={data.field303.vat}
            />

            {data.field309.turnover > 0 && (
              <div className="bg-white rounded-2xl p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-mono text-warm-gray">
                      309
                    </span>
                    <p className="text-sm text-charcoal mt-0.5">
                      0-verokannan alainen liikevaihto
                    </p>
                  </div>
                  <p className="text-lg font-medium text-charcoal">
                    {formatEur(data.field309.turnover)}
                  </p>
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl p-5 shadow-sm border-l-4 border-warning">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-warm-gray">
                    307
                  </span>
                  <p className="text-sm text-charcoal mt-0.5">
                    Verokauden vähennettävä vero
                  </p>
                </div>
                <Link
                  href={receiptDrillHref({
                    month: periodType === "month" ? period : null,
                    type: "meno",
                  })}
                  aria-label="Avaa ostokuitit"
                  className="text-lg font-medium text-charcoal underline decoration-warm-gray-light underline-offset-2"
                >
                  {formatEur(data.field307.amount)}
                </Link>
              </div>
            </div>

            <div
              className={`bg-white rounded-2xl p-5 shadow-sm border-l-4 ${
                data.field308.isRefund
                  ? "border-success"
                  : "border-accent"
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-warm-gray">
                    308
                  </span>
                  <p className="text-sm text-charcoal mt-0.5">
                    {data.field308.isRefund
                      ? "Palautukseen oikeuttava vero"
                      : "Maksettava vero"}
                  </p>
                </div>
                <p
                  className={`text-xl font-semibold ${
                    data.field308.isRefund
                      ? "text-success"
                      : "text-accent"
                  }`}
                >
                  {formatEur(data.field308.amount)}
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function OmaVeroField({
  code,
  label,
  sales,
  vat,
  href,
}: {
  code: string;
  label: string;
  sales: number;
  vat: number;
  href?: string;
}) {
  const amount = (value: number, labelText: string) =>
    href ? (
      <Link
        href={href}
        aria-label={labelText}
        className="text-charcoal font-medium underline decoration-warm-gray-light underline-offset-2"
      >
        {formatEur(value)}
      </Link>
    ) : (
      <span className="text-charcoal font-medium">{formatEur(value)}</span>
    );
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-xs font-mono text-warm-gray">{code}</span>
          <p className="text-sm text-charcoal mt-0.5">{label}</p>
        </div>
      </div>
      <div className="flex justify-between mt-3 text-sm">
        <span className="text-warm-gray">Myynti (veroton)</span>
        {amount(sales, `Avaa kuitit kentälle ${code}`)}
      </div>
      <div className="flex justify-between mt-1 text-sm">
        <span className="text-warm-gray">Vero</span>
        {amount(vat, `Avaa kuitit kentälle ${code}`)}
      </div>
    </div>
  );
}
