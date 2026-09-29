"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
  Copy,
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

import { formatDayMonth, formatEur } from "@/lib/format";
import { detailHref } from "@/lib/routes";
import { showToast } from "@/lib/toast";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { ReminderSheet } from "@/components/invoices/ReminderSheet";
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
  items?: DashboardItem[];
  itemTotals?: Record<ItemKind, number> | null;
  sectionErrors?: Partial<
    Record<"matching" | "vat" | "pending" | "threshold" | "position" | "receipts" | "items", string>
  >;
}

type ItemKind =
  | "overdue_invoice"
  | "pending_receipt"
  | "missing_receipt"
  | "invoice_match"
  | "receipt_match"
  | "payment_duplicate";

/** One concrete thing to do, as /api/dashboard returns it (see api/dashboard/items.ts). */
type DashboardItem =
  | {
      id: string;
      kind: "overdue_invoice";
      action: "remind";
      invoiceId: string;
      customerId: string;
      number: number;
      party: string;
      amount: number;
      dueDate: string;
      daysLate: number;
    }
  | {
      id: string;
      kind: "pending_receipt";
      action: "approve";
      receiptId: string;
      party: string;
      amount: number | null;
      type: string;
      date: string | null;
      category: string | null;
      vatRate: number | null;
    }
  | {
      id: string;
      kind: "invoice_match";
      action: "confirm_match";
      invoiceId: string;
      number: number;
      transactionId: string;
      party: string;
      amount: number;
      paidDate: string;
    }
  | {
      id: string;
      kind: "missing_receipt" | "receipt_match";
      action: "add_photo" | "review_match";
      transactionId: string;
      party: string;
      amount: number;
      date: string | null;
    }
  | {
      id: string;
      kind: "payment_duplicate";
      action: "open_invoice";
      invoiceId: string;
      number: number;
      party: string;
      amount: number;
      paidDate: string;
    };

interface Task {
  key: string;
  icon: LucideIcon;
  title: string;
  amount?: string;
  amountTone?: "default" | "positive";
  secondary: string;
  pill: string;
  /** Where the row itself leads (the item's own screen). */
  href: string;
  /** The pill's one-step action in place; without it the pill follows `href`. */
  onAction?: () => void;
}

/** Where each kind's full list lives ("Näytä kaikki"). */
const KIND_LIST: Record<ItemKind, { href: string; label: string }> = {
  overdue_invoice: { href: "/laskut?status=overdue", label: "Myöhässä olevat laskut" },
  pending_receipt: { href: "/kuitit", label: "Hyväksyntää odottavat kuitit" },
  missing_receipt: { href: "/pankki/taydennys", label: "Tapahtumat ilman kuittia" },
  invoice_match: { href: "/laskut", label: "Laskujen maksut tiliotteella" },
  receipt_match: { href: "/pankki/taydennys", label: "Tositeehdotukset" },
  payment_duplicate: { href: "/tyot", label: "Mahdolliset kaksoiskirjaukset" },
};

function vatRateText(rate: number): string {
  return `ALV ${String(rate).replace(".", ",")} %`;
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

/**
 * Rows not tied to one month (overdue purchase invoices, a bank balance that
 * does not reconcile): shown in the current month only.
 */
function buildAccountTasks(data: DashboardData): Task[] {
  const tasks: Task[] = [];
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

/** How many account-level things a task row stands for, for the headline. */
function accountTaskCount(data: DashboardData): number {
  const payables = !data.sectionErrors?.position ? (data.payables?.overdueCount ?? 0) : 0;
  return payables + (data.bank?.needsAttention ?? 0);
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
  // Items acted on in place: hidden at once, back if the action is undone or fails.
  const [hiddenItems, setHiddenItems] = useState<ReadonlySet<string>>(() => new Set());
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [remindTarget, setRemindTarget] = useState<{ invoiceId: string; customerId: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const hideItem = (id: string, hidden: boolean) =>
    setHiddenItems((current) => {
      const next = new Set(current);
      if (hidden) next.add(id);
      else next.delete(id);
      return next;
    });
  const reload = () => {
    if (mounted.current) setLoadAttempt((a) => a + 1);
  };

  /**
   * Hyväksy: the receipt leaves the list at once and the approval is sent
   * when the "Kumoa" toast closes without an undo (the infra undo pattern).
   * Closing the app meanwhile leaves the receipt pending, never half-done.
   */
  function approveReceipt(item: Extract<DashboardItem, { kind: "pending_receipt" }>) {
    hideItem(item.id, true);
    showToast({
      tone: "success",
      text: `${item.party} hyväksyttiin`,
      action: { label: "Kumoa", onAction: () => hideItem(item.id, false) },
      onDismiss: (reason) => {
        if (reason === "action") return;
        void apiFetch(`/api/receipts/${item.receiptId}/review`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewStatus: "approved" }),
        })
          .then((response) => readJson(response, "Kuitin hyväksyntä epäonnistui"))
          .then(reload)
          .catch((error: unknown) => {
            if (isUnauthorized(error)) {
              redirectToLogin();
              return;
            }
            if (mounted.current) hideItem(item.id, false);
            showToast({ tone: "error", text: errorMessage(error, "Kuitin hyväksyntä epäonnistui") });
          });
      },
    });
  }

  /** Kohdista: books the bank row as the invoice's payment; "Kumoa" removes it again. */
  async function confirmMatch(item: Extract<DashboardItem, { kind: "invoice_match" }>) {
    setBusyItem(item.id);
    try {
      const response = await apiFetch(`/api/invoices/${item.invoiceId}/payments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey() },
        body: JSON.stringify({
          amount: item.amount,
          paidDate: item.paidDate,
          transactionId: item.transactionId,
        }),
      });
      const result = await readJson<{
        invoice: { payments: Array<{ id: string; transactionId: string | null }> };
      }>(response, "Maksun kohdistus epäonnistui");
      const paymentId = result.invoice.payments.find(
        (payment) => payment.transactionId === item.transactionId
      )?.id;
      hideItem(item.id, true);
      showToast({
        tone: "success",
        text: `Maksu kirjattiin laskulle ${item.number}`,
        action: paymentId
          ? {
              label: "Kumoa",
              onAction: () => {
                void apiFetch(
                  `/api/invoices/${item.invoiceId}/payments?paymentId=${encodeURIComponent(paymentId)}`,
                  { method: "DELETE", credentials: "include" }
                )
                  .then((undo) => readJson(undo, "Kohdistuksen peruminen epäonnistui"))
                  .then(() => {
                    if (mounted.current) hideItem(item.id, false);
                    showToast({ text: "Kohdistus peruttiin" });
                    reload();
                  })
                  .catch((error: unknown) =>
                    showToast({
                      tone: "error",
                      text: errorMessage(error, "Kohdistuksen peruminen epäonnistui"),
                    })
                  );
              },
            }
          : undefined,
      });
      reload();
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Maksun kohdistus epäonnistui") });
    } finally {
      if (mounted.current) setBusyItem(null);
    }
  }

  function itemTask(item: DashboardItem): Task {
    switch (item.kind) {
      case "overdue_invoice":
        return {
          key: item.id,
          icon: BellRing,
          title: item.party,
          amount: formatEur(item.amount),
          secondary: `Lasku ${item.number} · myöhässä ${plural(item.daysLate, "päivä", "päivää")}`,
          pill: "Muistuta",
          href: detailHref("invoice", item.invoiceId),
          onAction: () => setRemindTarget({ invoiceId: item.invoiceId, customerId: item.customerId }),
        };
      case "pending_receipt":
        return {
          key: item.id,
          icon: Tag,
          title: item.party,
          amount: item.amount == null ? undefined : formatEur(item.amount),
          secondary:
            item.category && item.vatRate != null
              ? `${item.category}, ${vatRateText(item.vatRate)}`
              : item.category || (item.vatRate != null ? vatRateText(item.vatRate) : "Tarkista luokka ja ALV"),
          pill: "Hyväksy",
          href: detailHref("receipt", item.receiptId),
          onAction: () => approveReceipt(item),
        };
      case "missing_receipt":
        return {
          key: item.id,
          icon: Camera,
          title: item.party,
          amount: formatEur(Math.abs(item.amount)),
          amountTone: item.amount > 0 ? "positive" : "default",
          secondary: item.date ? `Kuitti puuttuu, ${formatDayMonth(item.date)}` : "Kuitti puuttuu",
          pill: "Lisää kuva",
          href: "/pankki/taydennys",
        };
      case "receipt_match":
        return {
          key: item.id,
          icon: ArrowLeftRight,
          title: item.party,
          amount: formatEur(Math.abs(item.amount)),
          secondary: "Tositeehdotus, tarkista",
          pill: "Tarkista",
          href: "/pankki/taydennys",
        };
      case "invoice_match":
        return {
          key: item.id,
          icon: ArrowLeftRight,
          title: item.party,
          amount: `+${formatEur(item.amount)}`,
          amountTone: "positive",
          secondary: `Maksu laskulle ${item.number}?`,
          pill: "Kohdista",
          href: detailHref("invoice", item.invoiceId),
          onAction: () => void confirmMatch(item),
        };
      case "payment_duplicate":
        return {
          key: item.id,
          icon: Copy,
          title: item.party,
          amount: formatEur(item.amount),
          secondary: `Sama tulo kahdesti? Lasku ${item.number}`,
          pill: "Tarkista",
          href: detailHref("invoice", item.invoiceId),
        };
    }
  }

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

  const visibleItems = (data?.items ?? []).filter((item) => !hiddenItems.has(item.id));
  const itemTasks = visibleItems.map(itemTask);
  const accountTasks = data && atCurrent ? buildAccountTasks(data) : [];
  // "Näytä kaikki" for each kind that has more than the rows shown.
  const moreRows = data?.itemTotals
    ? (Object.keys(KIND_LIST) as ItemKind[])
        .map((kind) => {
          const hidden = (data.items ?? []).filter(
            (item) => item.kind === kind && hiddenItems.has(item.id)
          ).length;
          const total = (data.itemTotals?.[kind] ?? 0) - hidden;
          const shown = visibleItems.filter((item) => item.kind === kind).length;
          return { kind, total, shown };
        })
        .filter((row) => row.total > row.shown)
    : [];
  // The headline counts things to do, not kinds of things.
  const hiddenCount = (data?.items ?? []).filter((item) => hiddenItems.has(item.id)).length;
  const openCount = data
    ? (data.itemTotals
        ? Object.values(data.itemTotals).reduce((sum, count) => sum + count, 0) - hiddenCount
        : visibleItems.length) + (atCurrent ? accountTaskCount(data) : 0)
    : 0;
  const hasTasks = itemTasks.length > 0 || accountTasks.length > 0 || moreRows.length > 0;
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
            <p className="text-headline font-semibold text-ink">
              {openCount <= 0
                ? "Kaikki kunnossa"
                : atCurrent
                  ? `${plural(openCount, "asia", "asiaa")} ennen kuun loppua`
                  : `${plural(openCount, "avoin asia", "avointa asiaa")}`}
            </p>
            {matching && matching.matchable > 0 && !data.sectionErrors?.matching ? (
              <>
                <p className="mt-0.5 text-body text-ink-2">
                  {matching.matched} / {matching.matchable} tapahtumaa on kunnossa
                </p>
                <ProgressSegments done={matching.matched} total={matching.matchable} />
              </>
            ) : data.source === "kuitit" ? (
              <p className="mt-0.5 text-body text-ink-2">
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
                className="active-press -mx-4 -mb-4 mt-4 flex min-h-12 items-center justify-between gap-3 border-t border-line px-4 py-3 text-body"
              >
                <span className="min-w-0">
                  <span className="block whitespace-nowrap text-ink">
                    {vatDue ? `ALV-ilmoitus ${vatDue}` : "ALV-arvio"}
                  </span>
                  <span className="block text-caption text-ink-2">
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

          {data.sectionErrors?.items ? (
            <ErrorState compact message={data.sectionErrors.items} onRetry={retry} />
          ) : null}

          {hasTasks ? (
            <Section title="Tarvitaan sinulta">
              {[...itemTasks, ...accountTasks].map((task) => (
                <ListRow
                  key={task.key}
                  href={task.href}
                  leading={<Icon icon={task.icon} />}
                  title={task.title}
                  amount={task.amount}
                  amountTone={task.amountTone}
                  secondary={task.secondary}
                  ariaLabel={[task.title, task.amount, task.secondary].filter(Boolean).join(", ")}
                  trailing={
                    task.onAction ? (
                      <ActionPill
                        onClick={task.onAction}
                        disabled={busyItem === task.key}
                        ariaLabel={`${task.pill}: ${task.title}`}
                      >
                        {task.pill}
                      </ActionPill>
                    ) : (
                      <ActionPill href={task.href} ariaLabel={`${task.pill}: ${task.title}`}>
                        {task.pill}
                      </ActionPill>
                    )
                  }
                />
              ))}
              {moreRows.map((row) => (
                <ListRow
                  key={`more:${row.kind}`}
                  href={KIND_LIST[row.kind].href}
                  chevron
                  title={`Näytä kaikki (${row.total})`}
                  secondary={KIND_LIST[row.kind].label}
                />
              ))}
            </Section>
          ) : null}

          <section>
            {/* One heading line: the basis belongs to the section, not to the Menot card below it. */}
            <h2 className="mb-2 px-1 text-caption font-normal text-ink-2">
              Kuukauden tulos
              <span aria-hidden> · </span>
              <span>{documentsBasis ? "laskujen ja kuittien mukaan" : "tiliotteen mukaan"}</span>
            </h2>
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
      {remindTarget ? (
        <ReminderSheet
          invoiceId={remindTarget.invoiceId}
          customerId={remindTarget.customerId}
          isOpen
          onClose={() => setRemindTarget(null)}
          onSent={() => {
            setRemindTarget(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
