"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { LoadingState } from "@/components/AsyncState";
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
import { MONTHS } from "@/lib/finnish-months";
import { controlClass } from "@/components/ui";
import { Card, FilterChips, PageTitle, Section, SummaryCard } from "@/components/ds";

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

/** One row inside a field-group Section, styled like a KeyValueList row. */
function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 px-4 py-3 text-[15px]">
      <span className="text-ink-2">{label}</span>
      <span className="min-w-0 text-right font-medium text-ink">{value}</span>
    </div>
  );
}

/** A field's amount, as a drill link when one is given, plain text otherwise. */
function FieldAmount({ value, href, ariaLabel }: { value: number; href?: string; ariaLabel: string }) {
  if (!href) return <>{formatEur(value)}</>;
  return (
    <Link href={href} aria-label={ariaLabel} className="text-accent">
      {formatEur(value)}
    </Link>
  );
}

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
    <div className="space-y-6 pb-6">
      <PageTitle title="ALV-ilmoitus" subtitle="Kuukauden tai neljänneksen arvonlisävero." />

      {data && !data.vatRegistered && (
        <Card className="space-y-1 text-sm text-ink">
          <p className="font-medium">OmaVero-luonnos</p>
          <p>
            Et ole merkinnyt olevasi ALV-rekisterissä (
            <Link href="/asetukset/yritys" className="text-accent">
              Asetukset
            </Link>
            ). Tämä raportti on vain arvio - ALV-ilmoitusta ei tarvitse antaa, jos et ole
            ALV-rekisterissä.
          </p>
        </Card>
      )}

      <FilterChips
        label="Ilmoituskausi"
        items={[
          { id: "month", label: "Kuukausi" },
          { id: "quarter", label: "Neljännes" },
        ]}
        value={periodType}
        onChange={(value) => {
          setLoadError(null);
          setPeriodType(value);
        }}
      />

      {periodType === "month" ? (
        <select
          aria-label="ALV-raportin kuukausi"
          value={selectedMonth}
          onChange={(e) => {
            setLoadError(null);
            setSelectedMonth(e.target.value);
          }}
          className={controlClass}
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
          className={controlClass}
        >
          {buildQuarterOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

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
        <>
          <p className="text-[13px] text-ink-2 text-center">
            OmaVero-ilmoituksen kentät · {data.receiptCount} kuittia kaudella
            {data.sources && data.sources.invoiceCount > 0 && (
              <> · {data.sources.invoiceCount} myyntilaskua</>
            )}
          </p>

          {data.sources && data.sources.invoiceCount > 0 && (
            <Card className="space-y-1 text-sm text-ink">
              <p className="font-medium">Myynnin ALV kahdesta lähteestä</p>
              <p className="text-[13px] text-ink-2">
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
            </Card>
          )}

          {data.review.count > 0 && (
            <Card className="space-y-1 text-sm text-ink">
              <p className="font-medium">{data.review.count} kuittia ilman ALV-erittelyä</p>
              <p className="text-[13px] text-ink-2">
                Myynnit {formatEur(data.review.salesGross)} · Ostot{" "}
                {formatEur(data.review.purchasesGross)}. Lisää ALV-tiedot kuiteille, jotta ne
                lasketaan mukaan.
              </p>
            </Card>
          )}

          <SummaryCard
            label={data.field308.isRefund ? "Palautukseen oikeuttava vero" : "Maksettava vero"}
            value={formatEur(data.field308.amount)}
          />

          <Section title="301 · Vero kotimaan myynnistä 25,5 %">
            <FieldRow
              label="Myynti (veroton)"
              value={
                <FieldAmount
                  value={data.field301.netSales}
                  href={receiptDrillHref({ month: periodType === "month" ? period : null, type: "tulo" })}
                  ariaLabel="Avaa kuitit kentälle 301"
                />
              }
            />
            <FieldRow
              label="Vero"
              value={
                <FieldAmount
                  value={data.field301.vat}
                  href={receiptDrillHref({ month: periodType === "month" ? period : null, type: "tulo" })}
                  ariaLabel="Avaa kuitit kentälle 301"
                />
              }
            />
          </Section>

          <Section title="302 · Vero kotimaan myynnistä 13,5 %">
            <FieldRow label="Myynti (veroton)" value={formatEur(data.field302.netSales)} />
            <FieldRow label="Vero" value={formatEur(data.field302.vat)} />
          </Section>

          <Section title="303 · Vero kotimaan myynnistä 10 %">
            <FieldRow label="Myynti (veroton)" value={formatEur(data.field303.netSales)} />
            <FieldRow label="Vero" value={formatEur(data.field303.vat)} />
          </Section>

          {data.field309.turnover > 0 && (
            <Section title="309 · 0-verokannan alainen liikevaihto">
              <FieldRow label="Liikevaihto" value={formatEur(data.field309.turnover)} />
            </Section>
          )}

          <Section title="307 · Verokauden vähennettävä vero">
            <FieldRow
              label="Vero"
              value={
                <FieldAmount
                  value={data.field307.amount}
                  href={receiptDrillHref({ month: periodType === "month" ? period : null, type: "meno" })}
                  ariaLabel="Avaa ostokuitit"
                />
              }
            />
          </Section>
        </>
      ) : null}
    </div>
  );
}
