"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/AsyncState";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { PageTitle, Section, ListRow, StatusTag, SummaryCard } from "@/components/ds";

import { formatEur } from "@/lib/format";
import { alvDrillHref, receiptDrillHref, statementDrillHref } from "@/lib/report-drill";
import { helsinkiMonthKey } from "@/lib/validation";
import { MONTHS } from "@/lib/finnish-months";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { pollDelay, syncPageHiddenFlag } from "@/lib/page-activity";
import { useProfile } from "@/app/asetukset/useProfile";

interface DashboardData {
  firstName: string;
  month: string;
  income: number;
  expenses: number;
  source: "tiliote" | "kuitit";
  txCount: number;
  receiptCount: number;
  estimatedVat: number;
  isRefund: boolean;
  matching: { matchable: number; matched: number; suggested: number };
  vat: {
    registered: boolean;
    entityType: string;
    ytdRevenue: number;
    threshold: number;
  };
  hasImap: boolean;
  pendingReceiptsCount?: number;
  isSingleVatProfile?: boolean;
  singleVatRate?: number;
  sectionErrors?: Partial<
    Record<"matching" | "vat" | "pending" | "threshold" | "position" | "receipts", string>
  >;
}

function getGreeting(firstName: string): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 10) return `Hyvää huomenta, ${firstName}!`;
  if (hour >= 10 && hour < 17) return `Hyvää päivää, ${firstName}!`;
  if (hour >= 17 && hour < 23) return `Hyvää iltaa, ${firstName}!`;
  return `Hyvää yötä, ${firstName}!`;
}

function currentMonth(): string {
  return helsinkiMonthKey();
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function ChevronLeftIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** The small chevron control under the page title (spec §10). */
function MonthSwitcher({ month, onChange }: { month: string; onChange: (next: string) => void }) {
  const atCurrent = month >= currentMonth();
  return (
    <div className="-mt-3 mb-5 flex items-center gap-1 px-1">
      <button
        type="button"
        aria-label="Edellinen kuukausi"
        onClick={() => onChange(shiftMonth(month, -1))}
        className="active-press relative flex h-8 w-8 items-center justify-center rounded-full text-ink-2 before:absolute before:-inset-2 before:content-['']"
      >
        <ChevronLeftIcon />
      </button>
      <span className="min-w-[3ch] text-center text-[13px] tabular-nums text-ink-2">
        {month.split("-")[0]}
      </span>
      <button
        type="button"
        aria-label="Seuraava kuukausi"
        onClick={() => onChange(shiftMonth(month, 1))}
        disabled={atCurrent}
        className="active-press relative flex h-8 w-8 items-center justify-center rounded-full text-ink-2 disabled:opacity-30 before:absolute before:-inset-2 before:content-['']"
      >
        <ChevronRightIcon />
      </button>
    </div>
  );
}

function ReceiptIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 3.5h8.5L19 7v13.5H7A2.5 2.5 0 0 1 4.5 18V6A2.5 2.5 0 0 1 7 3.5Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6M9 16h4" />
    </svg>
  );
}

export default function DashboardClient({
  firstName,
}: {
  firstName: string;
}) {
  const { profile } = useProfile();
  const [result, setResult] = useState<{
    month: string;
    data: DashboardData;
  } | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [refreshFailed, setRefreshFailed] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Poll while the page is visible. A hidden document does not keep asking.
  useEffect(() => {
    let interval = 0;
    const arm = () => {
      window.clearInterval(interval);
      const delay = pollDelay(document.visibilityState, 30_000);
      syncPageHiddenFlag(delay == null);
      if (delay == null) return;
      interval = window.setInterval(() => setLoadAttempt((a) => a + 1), delay);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") setLoadAttempt((a) => a + 1);
      arm();
    };
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/dashboard?month=${month}`, { credentials: "include" })
      .then((response) =>
        readJson<DashboardData>(response, "Etusivun tietojen lataus epäonnistui")
      )
      .then((data) => {
        if (cancelled) return;
        if (
          !Number.isFinite(data.income) ||
          !Number.isFinite(data.expenses) ||
          !data.vat
        ) {
          throw new Error("Palvelin palautti virheelliset etusivun tiedot");
        }
        setRefreshFailed(null);
        writePageCache(`dashboard:${month}`, data);
        setResult({ month, data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setRefreshFailed(error);
      });
    return () => {
      cancelled = true;
    };
  }, [month, loadAttempt]);

  // Cached copy (warmed post-login or left by an earlier visit) paints in the
  // first frame; the fetch above replaces it silently when it lands.
  const data =
    result?.month === month
      ? result.data
      : readPageCache<DashboardData>(`dashboard:${month}`);
  const displayName = data?.firstName || firstName;

  const monthIdx = parseInt(month.split("-")[1]) - 1;
  const monthName = MONTHS[monthIdx] || "";
  const subtitle = profile?.businessName || (displayName ? getGreeting(displayName) : undefined);

  const tulotHref =
    data?.source === "tiliote" ? statementDrillHref(month) : receiptDrillHref({ month, type: "tulo" });
  const menotHref =
    data?.source === "tiliote" ? statementDrillHref(month) : receiptDrillHref({ month, type: "meno" });

  const matchingShortfall = data
    ? data.matching.matchable - data.matching.matched - data.matching.suggested
    : 0;

  return (
    <div className="space-y-6 pb-20">
      <PageTitle title={monthName} subtitle={subtitle} />
      <MonthSwitcher
        month={month}
        onChange={(next) => {
          setRefreshFailed(null);
          setMonth(next);
        }}
      />

      {data?.sectionErrors?.pending ? (
        <ErrorState
          compact
          message={data.sectionErrors.pending}
          onRetry={() => setLoadAttempt((a) => a + 1)}
        />
      ) : null}

      {refreshFailed && data ? (
        <StaleBanner
          fetchedAt={pageCacheFetchedAt(`dashboard:${month}`)}
          onRetry={() => setLoadAttempt((a) => a + 1)}
        />
      ) : null}
      {refreshFailed && !data ? (
        <ConnectionNotice
          error={refreshFailed}
          fallback={errorMessage(refreshFailed, "Etusivun tietojen lataus epäonnistui")}
          onRetry={() => setLoadAttempt((a) => a + 1)}
        />
      ) : !data ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="h-24 animate-pulse rounded-card border border-line bg-surface" />
            <div className="h-24 animate-pulse rounded-card border border-line bg-surface" />
          </div>
          <div className="h-32 animate-pulse rounded-card border border-line bg-surface" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Link href={tulotHref} aria-label="Avaa tulot" className="active-press block">
              <SummaryCard label="Tulot" value={formatEur(data.income)} />
            </Link>
            <Link href={menotHref} aria-label="Avaa menot" className="active-press block">
              <SummaryCard label="Menot" value={formatEur(data.expenses)} />
            </Link>
            {data.sectionErrors?.vat ? (
              <div className="col-span-2">
                <ErrorState
                  compact
                  message={data.sectionErrors.vat}
                  onRetry={() => setLoadAttempt((a) => a + 1)}
                />
              </div>
            ) : (
              <Link
                href={alvDrillHref(month)}
                aria-label="Avaa ALV-raportti"
                className="active-press col-span-2 block"
              >
                <SummaryCard
                  label="ALV-arvio"
                  value={`${data.isRefund ? "−" : ""}${formatEur(Math.abs(data.estimatedVat))}`}
                  note={data.isRefund ? "palautettavaa" : "maksettavaa"}
                  noteTone="muted"
                />
              </Link>
            )}
          </div>

          {data.sectionErrors?.receipts && (
            <ErrorState
              compact
              message={data.sectionErrors.receipts}
              onRetry={() => setLoadAttempt((a) => a + 1)}
            />
          )}

          <p className="px-1 text-[13px] text-ink-2">
            {data.source === "tiliote"
              ? `Tiliotteen perusteella (${data.txCount} tapahtumaa)`
              : "Kuitteihin perustuva näkymä · lataa tiliote"}
            {data.hasImap && " · Automaattinen tuonti aktiivinen"}
          </p>

          {data.sectionErrors?.position && (
            <ErrorState
              compact
              message={data.sectionErrors.position}
              onRetry={() => setLoadAttempt((a) => a + 1)}
            />
          )}

          {data.sectionErrors?.threshold ? (
            <ErrorState
              compact
              message={data.sectionErrors.threshold}
              onRetry={() => setLoadAttempt((a) => a + 1)}
            />
          ) : !data.vat.registered && data.vat.ytdRevenue >= data.vat.threshold * 0.75 ? (
            <div
              className={`rounded-card border p-4 text-sm ${
                data.vat.ytdRevenue >= data.vat.threshold
                  ? "border-danger/30 bg-danger/10 text-danger"
                  : "border-warning/30 bg-warning/10 text-ink"
              }`}
            >
              <p className="font-semibold">
                {data.vat.ytdRevenue >= data.vat.threshold ? "ALV-raja ylittynyt" : "ALV-raja lähestyy"}
              </p>
              <p className="mt-1 leading-relaxed">
                Liikevaihtosi tänä vuonna on {formatEur(data.vat.ytdRevenue)}. Raja on{" "}
                {formatEur(data.vat.threshold)}.
                {data.vat.ytdRevenue >= data.vat.threshold
                  ? " Rekisteröidy OmaVerossa heti."
                  : " Rekisteröidy hyvissä ajoin."}
              </p>
            </div>
          ) : null}
        </>
      )}

      {data?.sectionErrors?.matching && (
        <ErrorState
          compact
          message={data.sectionErrors.matching}
          onRetry={() => setLoadAttempt((a) => a + 1)}
        />
      )}

      <Section>
        {data && !data.sectionErrors?.pending && data.pendingReceiptsCount !== undefined && data.pendingReceiptsCount > 0 && (
          <ListRow
            href="/kuitit"
            leading={<ReceiptIcon />}
            title="Tarkastusta odottavia kuitteja"
            secondary={
              data.isSingleVatProfile
                ? `Kaikki myyntisi ovat ALV ${data.singleVatRate}%. Tarkista ja hyväksy yhdellä napautuksella.`
                : `${data.pendingReceiptsCount} tarkastamatonta kuittia tai luonnosta`
            }
          />
        )}
        {data && !data.sectionErrors?.matching && data.matching.matchable > 0 && (
          <ListRow
            href="/pankki/taydennys"
            title="Kuittien linkitys"
            secondary={`${data.matching.matched} / ${data.matching.matchable} tapahtumaa linkitetty`}
            trailing={
              matchingShortfall > 0 ? (
                <StatusTag tone="accent">{`${matchingShortfall} puuttuu`}</StatusTag>
              ) : (
                <StatusTag tone="success">Kaikki ok</StatusTag>
              )
            }
          />
        )}
        <ListRow href="/kuitit/uusi" leading={<ReceiptIcon />} title="Uusi kuitti" />
        <ListRow href="/kirjanpito" leading={<BookIcon />} title="Kirjanpito" />
      </Section>
    </div>
  );
}
