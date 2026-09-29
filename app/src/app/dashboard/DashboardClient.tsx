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
import {
  ArrowLeftRight,
  BellRing,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FileText,
  Landmark,
  Tag,
  Wallet,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  ActionPill,
  Icon,
  ListRow,
  PageTitle,
  Section,
  Skeleton,
  SkeletonCard,
  SkeletonGroup,
  SummaryCard,
  useSkeletonFade,
} from "@/components/ds";

import { formatEur } from "@/lib/format";
import { alvDrillHref, receiptDrillHref, statementDrillHref } from "@/lib/report-drill";
import { helsinkiMonthKey } from "@/lib/validation";
import { MONTHS } from "@/lib/finnish-months";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { pollDelay, syncPageHiddenFlag } from "@/lib/page-activity";
import { vatDeadline } from "@/lib/vat-deadline";
import { useProfile } from "@/app/asetukset/useProfile";
import { useSession } from "@/components/SessionProvider";

interface Position {
  totalOpen: number;
  overdue: number;
  overdueCount: number;
}

interface DashboardData {
  firstName: string;
  month: string;
  income: number;
  expenses: number;
  source: "tiliote" | "kuitit";
  basis?: "kassaperuste" | "laskutusperuste";
  txCount: number;
  receiptCount: number;
  invoiceCount?: number;
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
  bank?: { totalBalance: number; accountCount: number; needsAttention: number } | null;
  receivables?: Position;
  payables?: Position;
  isSingleVatProfile?: boolean;
  singleVatRate?: number;
  sectionErrors?: Partial<
    Record<"matching" | "vat" | "pending" | "threshold" | "position" | "receipts", string>
  >;
}

interface Task {
  key: string;
  icon: LucideIcon;
  title: string;
  amount?: string;
  amountTone?: "default" | "positive";
  secondary: string;
  pill: string;
  href: string;
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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "12.11." - the statutory due day of a monthly VAT return. */
function dayMonth(date: Date): string {
  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.`;
}

/**
 * Previous / next month as one compact control in the title row. The month
 * itself is the page title, so the control repeats nothing (SALES-35).
 */
function MonthStepper({ month, onChange }: { month: string; onChange: (next: string) => void }) {
  const atCurrent = month >= currentMonth();
  const button =
    "active-press flex h-11 w-11 items-center justify-center text-ink disabled:text-ink-2/40";
  return (
    <div className="flex h-11 items-center overflow-hidden rounded-full border border-line bg-surface">
      <button
        type="button"
        aria-label="Edellinen kuukausi"
        onClick={() => onChange(shiftMonth(month, -1))}
        className={button}
      >
        <Icon icon={ChevronLeft} />
      </button>
      <span aria-hidden className="h-5 w-px bg-line" />
      <button
        type="button"
        aria-label={atCurrent ? "Seuraava kuukausi (ei vielä alkanut)" : "Seuraava kuukausi"}
        onClick={() => onChange(shiftMonth(month, 1))}
        disabled={atCurrent}
        className={button}
      >
        <Icon icon={ChevronRight} />
      </button>
    </div>
  );
}

/** Koti's first frame at the final layout sizes (L1, SHELL-34). */
function KotiSkeleton() {
  return (
    <SkeletonGroup label="Ladataan kuukauden tilannetta" className="space-y-6">
      <SkeletonCard>
        <Skeleton className="mt-0.5 h-5 w-3/5" />
        <Skeleton tone="soft" className="mt-2.5 h-3.5 w-2/5" />
        <Skeleton tone="soft" className="mt-4 h-2 w-full" radius="full" />
        <div className="mt-4 border-t border-line pt-3.5">
          <Skeleton className="h-4 w-full" />
        </div>
      </SkeletonCard>
      <div>
        <Skeleton tone="soft" className="mx-1 mb-3 h-3 w-28" />
        <SkeletonCard className="space-y-5">
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Skeleton radius="card" className="h-9 w-9 shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton tone="soft" className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </SkeletonCard>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[0, 1].map((card) => (
          <SkeletonCard key={card}>
            <Skeleton className="mt-1 h-3 w-12" />
            <Skeleton className="mt-3 h-7 w-3/4" />
          </SkeletonCard>
        ))}
      </div>
    </SkeletonGroup>
  );
}

/** Done / total as a row of segments, like the approved Koti mockup. */
function ProgressSegments({ done, total }: { done: number; total: number }) {
  const segments = Math.min(Math.max(total, 1), 14);
  const filled = total === 0 ? 0 : Math.round((done / total) * segments);
  return (
    <div
      role="progressbar"
      aria-label="Tapahtumat kunnossa"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="mt-3.5 flex gap-1"
    >
      {Array.from({ length: segments }).map((_, index) => (
        <span
          key={index}
          className={`h-2 flex-1 rounded-full ${index < filled ? "bg-success" : "bg-line"}`}
        />
      ))}
    </div>
  );
}

function buildTasks(data: DashboardData): Task[] {
  const tasks: Task[] = [];
  const receivables = data.receivables;
  if (!data.sectionErrors?.position && receivables && receivables.overdueCount > 0) {
    tasks.push({
      key: "overdue",
      icon: BellRing,
      title:
        receivables.overdueCount === 1
          ? "Lasku myöhässä"
          : `${receivables.overdueCount} laskua myöhässä`,
      amount: formatEur(receivables.overdue),
      secondary: "Eräpäivä on mennyt",
      pill: "Muistuta",
      href: "/laskut?status=overdue",
    });
  }
  const pending = data.pendingReceiptsCount ?? 0;
  if (!data.sectionErrors?.pending && pending > 0) {
    tasks.push({
      key: "pending",
      icon: Tag,
      title: pending === 1 ? "Kuitti odottaa hyväksyntää" : `${pending} kuittia odottaa hyväksyntää`,
      secondary: data.isSingleVatProfile
        ? `Kaikki myyntisi ovat ALV ${data.singleVatRate} %`
        : "Tarkista luokka ja ALV",
      pill: "Hyväksy",
      href: "/kuitit",
    });
  }
  if (!data.sectionErrors?.matching) {
    const { matchable, matched, suggested } = data.matching;
    const missing = matchable - matched - suggested;
    if (suggested > 0) {
      tasks.push({
        key: "suggested",
        icon: ArrowLeftRight,
        title: suggested === 1 ? "Ehdotettu kohdistus" : `${suggested} ehdotettua kohdistusta`,
        secondary: "Tarkista, että tosite kuuluu tapahtumalle",
        pill: "Kohdista",
        href: "/pankki/taydennys",
      });
    }
    if (missing > 0) {
      tasks.push({
        key: "missing",
        icon: Camera,
        title: missing === 1 ? "Tapahtuma ilman kuittia" : `${missing} tapahtumaa ilman kuittia`,
        secondary: "Lisää kuitti tai merkitse, ettei sitä tarvita",
        pill: "Lisää kuva",
        href: "/pankki/taydennys",
      });
    }
  }
  const payables = data.payables;
  if (!data.sectionErrors?.position && payables && payables.overdueCount > 0) {
    tasks.push({
      key: "payables",
      icon: FileText,
      title:
        payables.overdueCount === 1
          ? "Ostolasku myöhässä"
          : `${payables.overdueCount} ostolaskua myöhässä`,
      amount: formatEur(payables.overdue),
      secondary: "Maksa tai merkitse maksetuksi",
      pill: "Avaa",
      href: "/kirjanpito/ostolaskut",
    });
  }
  if (data.bank && data.bank.needsAttention > 0) {
    tasks.push({
      key: "bank",
      icon: Landmark,
      title:
        data.bank.needsAttention === 1
          ? "Pankkitilin saldo ei täsmää"
          : `${data.bank.needsAttention} pankkitilin saldo ei täsmää`,
      secondary: "Tarkista tiliotteet",
      pill: "Tarkista",
      href: "/kirjanpito/pankkitilit",
    });
  }
  return tasks;
}

export default function DashboardClient() {
  const { user } = useSession();
  const firstName = user?.firstName || "";
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
  const fade = useSkeletonFade(!data && !refreshFailed);
  const displayName = data?.firstName || firstName;
  const retry = () => setLoadAttempt((a) => a + 1);

  const [yearText, monthText] = month.split("-");
  const monthName = MONTHS[Number(monthText) - 1] || "";
  const atCurrent = month >= currentMonth();
  const title =
    yearText === currentMonth().slice(0, 4) ? monthName : `${monthName} ${yearText}`;
  const subtitle = atCurrent ? (
    // The line is always there (min height), so nothing below moves when the
    // profile or the name arrives after the first frame (SHELL-08).
    <span className="block min-h-[22px]">
      {profile?.businessName || (displayName ? getGreeting(displayName) : "")}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => {
        setRefreshFailed(null);
        setMonth(currentMonth());
      }}
      className="relative block min-h-[22px] font-medium text-accent before:absolute before:inset-x-0 before:-inset-y-[11px] before:content-['']"
    >
      Palaa kuluvaan kuuhun
    </button>
  );

  const tasks = data ? buildTasks(data) : [];
  const matching = data?.matching;
  const documentsBasis = data?.source !== "tiliote";
  const tulotHref = !data
    ? "/raportit"
    : data.source === "tiliote"
      ? statementDrillHref(month)
      : (data.invoiceCount ?? 0) > 0
        ? `/laskut?month=${month}`
        : receiptDrillHref({ month, type: "tulo" });
  const menotHref =
    data?.source === "tiliote" ? statementDrillHref(month) : receiptDrillHref({ month, type: "meno" });
  const vatDue =
    profile?.vatRegistered && (profile.vatPeriod === "month" || !profile.vatPeriod)
      ? dayMonth(
          vatDeadline({ kind: "month", year: Number(yearText), month: Number(monthText) })
        )
      : null;

  return (
    <div className="space-y-6">
      <PageTitle
        title={title}
        subtitle={subtitle}
        action={
          <MonthStepper
            month={month}
            onChange={(next) => {
              setRefreshFailed(null);
              setMonth(next);
            }}
          />
        }
      />

      {refreshFailed && data ? (
        <StaleBanner fetchedAt={pageCacheFetchedAt(`dashboard:${month}`)} onRetry={retry} />
      ) : null}
      {refreshFailed && !data ? (
        <ConnectionNotice
          error={refreshFailed}
          fallback={errorMessage(refreshFailed, "Etusivun tietojen lataus epäonnistui")}
          onRetry={retry}
        />
      ) : !data ? (
        <KotiSkeleton />
      ) : (
        <div className={`space-y-6 ${fade}`}>
          {/* Month status: what is still open, how much of the bank is in order, VAT. */}
          <div className="rounded-card border border-line bg-surface p-4">
            <p className="text-[17px] font-semibold text-ink">
              {tasks.length === 0
                ? "Kaikki kunnossa"
                : atCurrent
                  ? `${plural(tasks.length, "asia", "asiaa")} ennen kuun loppua`
                  : `${plural(tasks.length, "avoin asia", "avointa asiaa")}`}
            </p>
            {matching && matching.matchable > 0 && !data.sectionErrors?.matching ? (
              <>
                <p className="mt-0.5 text-[15px] text-ink-2">
                  {matching.matched} / {matching.matchable} tapahtumaa on kunnossa
                </p>
                <ProgressSegments done={matching.matched} total={matching.matchable} />
              </>
            ) : data.source === "kuitit" ? (
              <p className="mt-0.5 text-[15px] text-ink-2">
                Tämän kuun tiliotetta ei ole vielä.{" "}
                <Link
                  href="/pankki/tapahtumat?import=1"
                  className="relative font-medium text-accent before:absolute before:inset-x-0 before:-inset-y-[12px] before:content-['']"
                >
                  Tuo tiliote
                </Link>
              </p>
            ) : null}
            {data.sectionErrors?.vat ? (
              <div className="mt-4 border-t border-line pt-3">
                <ErrorState compact message={data.sectionErrors.vat} onRetry={retry} />
              </div>
            ) : (
              <Link
                href={alvDrillHref(month)}
                aria-label="Avaa ALV-raportti"
                className="active-press -mx-4 -mb-4 mt-4 flex min-h-12 items-center justify-between gap-3 border-t border-line px-4 py-3 text-[15px]"
              >
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-ink">
                    {vatDue ? `ALV-ilmoitus ${vatDue}` : "ALV-arvio"}
                  </span>
                  <span className="block text-[13px] text-ink-2">
                    {data.isRefund ? "palautettavaa" : "maksettavaa"}
                  </span>
                </span>
                <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums text-ink">
                  {formatEur(Math.abs(data.estimatedVat))}
                </span>
              </Link>
            )}
          </div>

          {data.sectionErrors?.pending || data.sectionErrors?.matching ? (
            <ErrorState
              compact
              message={data.sectionErrors.pending || data.sectionErrors.matching}
              onRetry={retry}
            />
          ) : null}

          {tasks.length > 0 ? (
            <Section title="Tarvitaan sinulta">
              {tasks.map((task) => (
                <ListRow
                  key={task.key}
                  href={task.href}
                  leading={<Icon icon={task.icon} />}
                  title={task.title}
                  amount={task.amount}
                  secondary={task.secondary}
                  ariaLabel={[task.title, task.amount, task.secondary].filter(Boolean).join(", ")}
                  trailing={
                    <ActionPill href={task.href} ariaLabel={`${task.pill}: ${task.title}`}>
                      {task.pill}
                    </ActionPill>
                  }
                />
              ))}
            </Section>
          ) : null}

          <section>
            <div className="mb-2 flex items-baseline justify-between gap-3 px-1 text-[13px] text-ink-2">
              <h2 className="font-normal">Kuukauden tulos</h2>
              <span>{documentsBasis ? "Laskujen ja kuittien mukaan" : "Tiliotteen mukaan"}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Link href={tulotHref} aria-label="Avaa tulot" className="active-press block">
                <SummaryCard label="Tulot" value={formatEur(data.income)} />
              </Link>
              <Link href={menotHref} aria-label="Avaa menot" className="active-press block">
                <SummaryCard label="Menot" value={formatEur(data.expenses)} />
              </Link>
            </div>
            {data.sectionErrors?.receipts ? (
              <div className="mt-3">
                <ErrorState compact message={data.sectionErrors.receipts} onRetry={retry} />
              </div>
            ) : null}
          </section>

          {data.sectionErrors?.position ? (
            <ErrorState compact message={data.sectionErrors.position} onRetry={retry} />
          ) : (
            <Section title="Rahatilanne">
              <ListRow
                href="/kirjanpito/pankkitilit"
                leading={<Icon icon={Landmark} />}
                title="Pankkitilit"
                amount={data.bank && data.bank.accountCount > 0 ? formatEur(data.bank.totalBalance) : undefined}
                secondary={
                  data.bank && data.bank.accountCount > 0
                    ? plural(data.bank.accountCount, "tili", "tiliä")
                    : "Ei yhdistettyä tiliä"
                }
                ariaLabel={
                  data.bank && data.bank.accountCount > 0
                    ? `Pankkitilit, ${formatEur(data.bank.totalBalance)}`
                    : "Pankkitilit, ei yhdistettyä tiliä"
                }
                trailing={
                  data.bank && data.bank.accountCount > 0 ? undefined : (
                    <ActionPill href="/kirjanpito/pankkitilit" ariaLabel="Yhdistä pankki">
                      Yhdistä
                    </ActionPill>
                  )
                }
              />
              <ListRow
                href="/laskut"
                leading={<Icon icon={Wallet} />}
                title="Myyntisaamiset"
                amount={formatEur(data.receivables?.totalOpen ?? 0)}
                secondary={
                  data.receivables && data.receivables.overdue > 0
                    ? `${formatEur(data.receivables.overdue)} erääntynyt`
                    : "Ei erääntyneitä"
                }
                ariaLabel={`Myyntisaamiset, ${formatEur(data.receivables?.totalOpen ?? 0)}`}
                trailing={
                  <ActionPill href="/laskut/uusi" ariaLabel="Uusi lasku">
                    Uusi lasku
                  </ActionPill>
                }
              />
              {data.payables && data.payables.totalOpen > 0 ? (
                <ListRow
                  href="/kirjanpito/ostolaskut"
                  leading={<Icon icon={FileText} />}
                  title="Ostovelat"
                  amount={formatEur(data.payables.totalOpen)}
                  secondary={
                    data.payables.overdue > 0
                      ? `${formatEur(data.payables.overdue)} erääntynyt`
                      : "Ei erääntyneitä"
                  }
                  ariaLabel={`Ostovelat, ${formatEur(data.payables.totalOpen)}`}
                />
              ) : null}
            </Section>
          )}

          {matching && matching.matched > 0 ? (
            <Section title="Hoidettu">
              <ListRow
                href="/pankki/tapahtumat"
                leading={<Icon icon={matching.matched === matching.matchable ? CircleCheck : Sparkles} />}
                chevron
                title={`${plural(matching.matched, "tapahtuma", "tapahtumaa")} kohdistettu`}
                secondary={
                  data.hasImap
                    ? "Kuitit tulevat myös sähköpostista"
                    : "Tiliotteen tapahtumat, joilla on tosite"
                }
              />
            </Section>
          ) : null}

          {data.sectionErrors?.threshold ? (
            <ErrorState compact message={data.sectionErrors.threshold} onRetry={retry} />
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
        </div>
      )}
    </div>
  );
}
