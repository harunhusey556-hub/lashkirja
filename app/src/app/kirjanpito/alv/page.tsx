"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { SectionSkeleton } from "@/components/books/Skeletons";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

import { formatEur, kuittiCount } from "@/lib/format";
import { receiptDrillHref } from "@/lib/report-drill";
import { alvPeriodBoundsUtc, helsinkiCalendarDate, helsinkiMonthKey } from "@/lib/validation";
import { VatFilingCard } from "@/components/VatFilingCard";
import { vatDueFor, vatPeriodKindOf, type VatPeriodKind } from "@/lib/vat-deadline";
import {
  ALV_PERIOD_KEY,
  alvKeyForKind,
  alvKeyKind,
  alvPeriodOptions,
  periodOfKey,
  resolveAlvPeriod,
  type AlvChoice,
} from "@/lib/alv-period-choice";
import { alvPurchaseNote, vatPendingNote, type VatFilingRecord } from "@/lib/vat-due";
import { useProfile } from "@/app/asetukset/useProfile";
import { useRefetchOnReconnect } from "@/components/useRefetchOnReconnect";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { controlClass } from "@/components/ui";
import { Card, FilterChips, ListRow, PageTitle, Section, Skeleton, SkeletonCard, SkeletonGroup, SummaryCard } from "@/components/ds";

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
  sources?: {
    receiptSalesVat: number;
    invoiceSalesVat: number;
    invoiceCount: number;
    /** F39: deductible VAT from purchase invoices, already inside field 307. */
    purchaseInvoiceVat?: number;
    purchaseInvoiceCount?: number;
  };
  skippedPurchaseInvoiceCount?: number;
  suspectedPurchaseDuplicateCount?: number;
  purchaseReceiptUnusableCount?: number;
  excludedReceiptCount?: number;
  creditedInvoiceCount?: number;
  creditNoteCount?: number;
  /** FP-13: the owner's filed / paid record for the period. */
  filing?: VatFilingRecord | null;
  /** TF-11: pending receipts dated in the period, not in the figures yet. */
  pendingReceiptCount?: number;
}

/** The period a link asks for (`?period=2026-Q3`), read once when the page opens. */
function periodFromLink(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("period");
  return raw && ALV_PERIOD_KEY.test(raw) ? raw : null;
}

const KIND_CHIPS: Array<{ id: VatPeriodKind; label: string }> = [
  { id: "month", label: "Kuukausi" },
  { id: "quarter", label: "Neljännes" },
  { id: "year", label: "Vuosi" },
];

const PERIOD_SELECT_LABEL: Record<VatPeriodKind, string> = {
  month: "ALV-raportin kuukausi",
  quarter: "ALV-raportin neljännes",
  year: "ALV-raportin vuosi",
};

// Extends a small inline text link's touch target to >=44px tall without
// growing what's actually drawn (mirrors ActionPill's own before:-inset-y-1
// trick, just with a bigger inset since this text is ~19px tall, not 36px).
const HIT44 = "relative before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']";

/** One row inside a field-group Section, styled like a KeyValueList row. */
function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 px-4 py-3 text-body">
      <span className="text-ink-2">{label}</span>
      <span className="min-w-0 text-right font-medium text-ink">{value}</span>
    </div>
  );
}

/**
 * A field whose receipts can be opened: a full-width row with a chevron
 * (BOOKS-22, T1), not a 19 px inline link.
 */
function DrillRow({ label, value, href, ariaLabel }: { label: string; value: number; href: string; ariaLabel: string }) {
  return <ListRow href={href} title={label} amount={formatEur(value)} chevron ariaLabel={`${ariaLabel}: ${label} ${formatEur(value)}`} />;
}

export default function ALVRaporttiPage() {
  const now = new Date();
  const { profile, loadError: profileError } = useProfile();
  const dueKind = vatPeriodKindOf(profile?.vatPeriod);

  // F13: the page opens on the return the profile's ALV-verokausi makes due (the same one Koti and the
  // month close name), unless a link asked for another period or the owner chose one under this setting.
  const [linkKey, setLinkKey] = useState<string | null>(periodFromLink);
  const [choice, setChoice] = usePersistedState<AlvChoice | null>("alv.choice", null);
  const period = resolveAlvPeriod({ link: linkKey, choice, vatPeriod: profile?.vatPeriod, now });
  const periodKind = alvKeyKind(period);
  // Until the profile is known the default period is a guess; do not fetch or paint it.
  const ready = linkKey !== null || profile !== null || Boolean(profileError);
  function pickPeriod(key: string) {
    setLoadError(null);
    setLinkKey(null);
    setChoice({ key, kind: dueKind });
  }

  const [filingOverride, setFilingOverride] = useState<{ period: string; filing: VatFilingRecord | null } | null>(null);
  const [result, setResult] = useState<{
    period: string;
    data: ALVData;
  } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useRefetchOnReconnect(() => setLoadAttempt((attempt) => attempt + 1));

  useEffect(() => {
    if (!ready) return;
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
  }, [period, loadAttempt, ready]);

  // A previously computed period paints instantly from the cache while the
  // fetch above recomputes it in the background.
  // On a cold launch the cache is hydrated after this page mounted, so the
  // copy from the last session is picked up once it is readable (N3).
  const lateData = useCacheAfterBoot<ALVData>(`alv:${period}`);
  const data = !ready
    ? null
    : result?.period === period
      ? result.data
      : readPageCache<ALVData>(`alv:${period}`) ?? lateData;
  const loading = !data && !loadError;
  // FP-12: the drill opens the documents the figure is made of.
  const invoiceSales = (data?.sources?.invoiceCount ?? 0) > 0;
  const salesFromBoth = invoiceSales && (data?.sources?.receiptSalesVat ?? 0) !== 0;
  // Lists filter by a month or a whole year; a quarter has no list filter of its own.
  const drillScope = periodKind === "quarter" ? null : period;
  const salesHref = invoiceSales
    ? drillScope
      ? `/laskut?month=${drillScope}`
      : "/laskut"
    : receiptDrillHref({ month: drillScope, type: "tulo" });
  const salesDrillLabel = invoiceSales ? "Avaa myyntilaskut kentälle 301" : "Avaa kuitit kentälle 301";
  useScrollRestoration("alv", Boolean(data));

  return (
    <div className="space-y-6">
      <PageTitle title="ALV-ilmoitus" subtitle="Arvonlisävero ilmoituskaudelta." />

      {data && !data.vatRegistered && (
        <Card className="space-y-1 text-sm text-ink">
          <p className="font-medium">OmaVero-luonnos</p>
          <p>
            Et ole merkinnyt olevasi ALV-rekisterissä (
            <Link href="/asetukset/yritys" className={`text-accent ${HIT44}`}>
              Asetukset
            </Link>
            ). Tämä raportti on vain arvio - ALV-ilmoitusta ei tarvitse antaa, jos et ole
            ALV-rekisterissä.
          </p>
        </Card>
      )}

      <FilterChips
        label="Ilmoituskausi"
        items={KIND_CHIPS}
        value={periodKind}
        onChange={(value) => pickPeriod(alvKeyForKind(value, now))}
      />

      <select
        aria-label={PERIOD_SELECT_LABEL[periodKind]}
        value={period}
        onChange={(e) => pickPeriod(e.target.value)}
        className={controlClass}
      >
        {alvPeriodOptions(periodKind, Number(helsinkiMonthKey(now).slice(0, 4)), period).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

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
        <SkeletonGroup label="Ladataan ALV-raporttia" className="space-y-6">
          <Skeleton tone="soft" className="mx-1 h-3 w-3/5" />
          <SkeletonCard>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-2/5" />
          </SkeletonCard>
          <SectionSkeleton rows={2} />
          <SectionSkeleton rows={2} />
        </SkeletonGroup>
      ) : data ? (
        <>
          <p className="px-1 text-caption leading-relaxed text-ink-2">
            OmaVero-ilmoituksen kentät · {data.receiptCount} {data.receiptCount === 1 ? "kuitti" : "kuittia"} kaudella
            {data.sources && data.sources.invoiceCount > 0 && (
              <>
                {" "}
                · {data.sources.invoiceCount} {data.sources.invoiceCount === 1 ? "myyntilasku" : "myyntilaskua"}
              </>
            )}
          </p>

          {data.sources && data.sources.invoiceCount > 0 && (
            <Card className="space-y-1 text-sm text-ink">
              <p className="font-medium">Myynnin ALV kahdesta lähteestä</p>
              <p className="text-caption text-ink-2">
                Kuiteista {formatEur(data.sources.receiptSalesVat)} · myyntilaskuista{" "}
                {formatEur(data.sources.invoiceSalesVat)}. Laskut lasketaan laskun päivän
                mukaan (suoriteperuste).
                {data.excludedReceiptCount ? (
                  <>
                    {" "}
                    {kuittiCount(data.excludedReceiptCount)} jätettiin pois, koska sama
                    pankkitapahtuma on jo kohdistettu laskulle.
                  </>
                ) : null}
                {data.creditNoteCount ? (
                  <>
                    {" "}
                    {data.creditNoteCount === 1
                      ? "1 hyvityslasku vähentää myyntiä tällä kaudella."
                      : `${data.creditNoteCount} hyvityslaskua vähentävät myyntiä tällä kaudella.`}
                  </>
                ) : null}
              </p>
            </Card>
          )}

          {(data.sources?.purchaseInvoiceCount ?? 0) > 0 || (data.skippedPurchaseInvoiceCount ?? 0) > 0 || (data.purchaseReceiptUnusableCount ?? 0) > 0 ? (
            <Card className="space-y-1 text-sm text-ink">
              <p className="font-medium">Ostolaskujen ALV</p>
              <p className="text-caption text-ink-2">
                {alvPurchaseNote({
                  count: data.sources?.purchaseInvoiceCount ?? 0,
                  vat: data.sources?.purchaseInvoiceVat ?? 0,
                  skipped: data.skippedPurchaseInvoiceCount ?? 0,
                  suspected: data.suspectedPurchaseDuplicateCount ?? 0,
                  unusable: data.purchaseReceiptUnusableCount ?? 0,
                })}
              </p>
            </Card>
          ) : null}

          {data.review.count > 0 && (
            <Card className="space-y-1 text-sm text-ink">
              <p className="font-medium">{kuittiCount(data.review.count)} ilman ALV-erittelyä</p>
              <p className="text-caption text-ink-2">
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

          {vatPendingNote({ amount: data.field308.amount, isRefund: data.field308.isRefund, filing: null, pendingReceiptCount: data.pendingReceiptCount ?? 0 }) ? (
            <p className="-mt-3 px-1 text-caption text-warning" role="note">
              {vatPendingNote({ amount: data.field308.amount, isRefund: data.field308.isRefund, filing: null, pendingReceiptCount: data.pendingReceiptCount ?? 0 })}
            </p>
          ) : null}

          {data.vatRegistered ? (
            <VatFilingCard
              periodKey={period}
              periodLabel={vatDueFor(periodOfKey(period)).label}
              dueIso={vatDueFor(periodOfKey(period)).dueIso}
              amount={data.field308.amount}
              isRefund={data.field308.isRefund}
              filing={filingOverride?.period === period ? filingOverride.filing : (data.filing ?? null)}
              periodEnded={alvPeriodBoundsUtc(period).end.toISOString().slice(0, 10) <= helsinkiCalendarDate(now)}
              pendingReceiptCount={data.pendingReceiptCount ?? 0}
              onChanged={(filing) => setFilingOverride({ period, filing })}
            />
          ) : null}

          <Section title="301 · Vero kotimaan myynnistä 25,5 %">
            <DrillRow
              label="Myynti (veroton)"
              value={data.field301.netSales}
              href={salesHref}
              ariaLabel={salesDrillLabel}
            />
            <DrillRow
              label="Vero"
              value={data.field301.vat}
              href={salesHref}
              ariaLabel={salesDrillLabel}
            />
            {salesFromBoth ? (
              <DrillRow
                label="Myyntikuiteista"
                value={data.sources?.receiptSalesVat ?? 0}
                href={receiptDrillHref({ month: drillScope, type: "tulo" })}
                ariaLabel="Avaa myyntikuitit kentälle 301"
              />
            ) : null}
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
            <DrillRow
              label="Vero"
              value={data.field307.amount}
              href={receiptDrillHref({ month: drillScope, type: "meno" })}
              ariaLabel="Avaa ostokuitit"
            />
            {(data.sources?.purchaseInvoiceCount ?? 0) > 0 ? (
              <DrillRow
                label="Ostolaskuista"
                value={data.sources?.purchaseInvoiceVat ?? 0}
                href="/kirjanpito/ostolaskut"
                ariaLabel="Avaa ostolaskut"
              />
            ) : null}
          </Section>
        </>
      ) : null}
    </div>
  );
}
