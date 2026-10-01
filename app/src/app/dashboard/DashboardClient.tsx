"use client";

import { PullToRefresh } from "@/components/ds/PullToRefresh";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ConnectionNotice, PartialFailureNotice, StaleBanner } from "@/components/ScreenState";
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
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  Copy,
  FilePen,
  FileText,
  Landmark,
  Percent,
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
import { receiptDrillHref, statementDrillHref } from "@/lib/report-drill";
import { helsinkiMonthKey } from "@/lib/validation";
import { MONTHS } from "@/lib/finnish-months";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { pollDelay, syncPageHiddenFlag } from "@/lib/page-activity";
import { vatPeriodEndingIn, vatPeriodKindOf } from "@/lib/vat-deadline";
import { VAT_ROW_TITLE, vatChangedNote, vatDueAmount, vatDueSecondary, vatPendingNote } from "@/lib/vat-due";
import {
  kotiHeadline,
  kotiMonthHasActivity,
  kotiResultBasis,
  kotiResultLabel,
  kotiStatementLine,
  parseKotiMonth,
  rememberKotiMonth,
} from "@/lib/koti-month";
import { useVatDue } from "@/components/useVatDue";
import { approvalGapText } from "@/lib/receipt-approval";
import { requestReceiptCapture, requestStatementImport } from "@/lib/capture-request";
import { useLeavingRows } from "@/components/useLeavingRows";
import { armNavigation } from "@/lib/nav-direction";
import { ReceiptApprovalSheet, type ApprovalSheetReceipt } from "@/components/ReceiptApprovalSheet";
import type { DashboardItem as ServerDashboardItem, DashboardItemKind } from "@/app/api/dashboard/items";
import { isBlockingKind } from "@/lib/dashboard-kinds";
import { useProfile } from "@/app/asetukset/useProfile";
import { useSession } from "@/components/SessionProvider";
import { useRefetchOnReconnect } from "@/components/useRefetchOnReconnect";

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
  /** FP-2: the blocking items only; the headline counts these. */
  blockingTotal?: number | null;
  /** FP-3: last month, until it is closed. */
  previousMonth?: { month: string; open: number } | null;
  /** TF-06: the start checklist of a new account. */
  setup?: { receipts: boolean; bank: boolean; seller: boolean; empty: boolean } | null;
  sectionErrors?: Partial<
    Record<"matching" | "vat" | "pending" | "threshold" | "position" | "receipts" | "items", string>
  >;
}

type ItemKind = DashboardItemKind;

/** One concrete thing to do, as /api/dashboard returns it (see api/dashboard/items.ts). */
type DashboardItem = ServerDashboardItem;

interface Task {
  key: string;
  /** FP-2: counts in "ennen kuun loppua"; the rest sit under "Muut". */
  blocking: boolean;
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
  /** The row body's action in place (TF-03); without it the row follows `href`. */
  onRowClick?: () => void;
}

/** Where each kind's full list lives ("Näytä kaikki"). */
const KIND_LIST: Record<ItemKind, { href: string; label: string }> = {
  overdue_invoice: { href: "/laskut?status=overdue", label: "Myöhässä olevat laskut" },
  pending_receipt: { href: "/kuitit", label: "Hyväksyntää odottavat kuitit" },
  vat_gap: { href: "/kuitit", label: "Kuitit ilman ALV-erittelyä" },
  missing_receipt: { href: "/pankki/tapahtumat?nayta=toimet", label: "Pankkitapahtumat ilman kuittia" },
  invoice_match: { href: "/laskut", label: "Laskujen maksut tiliotteella" },
  receipt_match: { href: "/pankki/tapahtumat?nayta=toimet", label: "Kohdistusehdotukset" },
  payment_duplicate: { href: "/tyot", label: "Mahdolliset kaksoiskirjaukset" },
  draft_invoice: { href: "/laskut?status=draft", label: "Lähettämättömät laskut" },
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

/**
 * The Suspense fallback of the page: the same title row (month stepper and a
 * subtitle line of the final height) above the skeleton, so the static HTML is
 * already at the layout the loaded page has and nothing shifts when it hydrates
 * (L1, SHELL-34). The title text is a blank line: the month is only known on
 * the client, and the build month would show the wrong name.
 */
export function KotiFallback() {
  return (
    <div className="space-y-6">
      <PageTitle
        title={" "}
        subtitle={<span className="block min-h-[22px]" />}
        action={<MonthStepper month={currentMonth()} onChange={() => {}} />}
      />
      <KotiSkeleton />
    </div>
  );
}

/** Koti's first frame at the final layout sizes (L1, SHELL-34). */
export function KotiSkeleton() {
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
      blocking: false,
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
      blocking: false,
      pill: "Tarkista",
      href: "/kirjanpito/pankkitilit",
    });
  }
  return tasks;
}

/** The month's name in a sentence start: "Elokuu". */
function monthNameOf(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1] || month;
}

/** Where a month's close lives (FP-13). */
function monthCloseHref(month: string): string {
  return `/kirjanpito/kuukausi?month=${month}`;
}

export default function DashboardClient() {
  const router = useRouter();
  const { user } = useSession();
  const firstName = user?.firstName || "";
  const { profile } = useProfile();
  const [result, setResult] = useState<{
    month: string;
    data: DashboardData;
  } | null>(null);
  // F25: the month is part of the address, so Back from the month close or an invoice returns to it.
  const urlMonth = useSearchParams().get("month");
  const [month, setMonthState] = useState(() => parseKotiMonth(urlMonth, currentMonth()));
  const setMonth = (next: string) => {
    setMonthState(next);
    // replaceState, not a navigation: no history entry per tap, and Back still leaves Koti in one step.
    rememberKotiMonth(next, currentMonth());
  };
  const [refreshFailed, setRefreshFailed] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Items acted on in place: hidden at once, back if the action is undone or fails.
  const [hiddenItems, setHiddenItems] = useState<ReadonlySet<string>>(() => new Set());
  // A done task folds out of the list before it is hidden (owner report 2026-09-30).
  const { leaving, leave } = useLeavingRows();
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [remindTarget, setRemindTarget] = useState<{ invoiceId: string; customerId: string } | null>(null);
  // TF-03: the row body of a pending receipt opens the approval sheet in place.
  const [approvalTarget, setApprovalTarget] = useState<
    (ApprovalSheetReceipt & { id: string }) | null
  >(null);
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
  function approveReceipt(item: { id: string; receiptId: string; party: string }) {
    leave(item.id, () => hideItem(item.id, true));
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
      leave(item.id, () => hideItem(item.id, true));
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
      case "overdue_invoice": {
        // A reminder that is certain to be refused (the last one's term still
        // runs) is not offered: the row opens the invoice, which says when.
        // eslint-disable-next-line react-hooks/purity -- a wall-clock comparison; a stale render at worst offers the button one reload late
        const reminded = item.nextReminderAt != null && new Date(item.nextReminderAt).getTime() > Date.now();
        return {
          key: item.id,
          icon: BellRing,
          title: item.party,
          amount: formatEur(item.amount),
          secondary: `Lasku ${item.number} · myöhässä ${plural(item.daysLate, "päivä", "päivää")}${reminded ? " · muistutettu" : ""}`,
          pill: reminded ? "Avaa" : "Muistuta",
          blocking: false,
          href: detailHref("invoice", item.invoiceId),
          onAction: reminded
            ? undefined
            : () => setRemindTarget({ invoiceId: item.invoiceId, customerId: item.customerId }),
        };
      }
      case "pending_receipt": {
        // FP-6: a receipt without an amount or a vendor is never one-tap approved.
        const gaps = item.gaps ?? [];
        const openSheet = () => setApprovalTarget({ ...item, gaps });
        return {
          key: item.id,
          icon: Tag,
          title: item.party,
          amount: item.amount == null ? undefined : formatEur(item.amount),
          secondary:
            gaps.length > 0
              ? approvalGapText(gaps)
              : item.category && item.vatRate != null
                ? `${item.category} · ${vatRateText(item.vatRate)}`
                : item.category || (item.vatRate != null ? vatRateText(item.vatRate) : "Tarkista luokka ja ALV"),
          pill: gaps.length > 0 ? "Täydennä" : "Hyväksy",
          blocking: true,
          href: detailHref("receipt", item.receiptId),
          onAction: gaps.length > 0 ? openSheet : () => approveReceipt(item),
          onRowClick: openSheet,
        };
      }
      case "vat_gap":
        // F72: an approved receipt the VAT return cannot use; one tap to the receipt to add the breakdown.
        return {
          key: item.id,
          icon: Percent,
          title: item.party,
          amount: formatEur(item.amount),
          secondary:
            item.type === "meno"
              ? "ALV-erittely puuttuu · vähennys jää pois"
              : "ALV-erittely puuttuu · ei mukana ALV:ssa",
          pill: "Täydennä",
          blocking: true,
          href: detailHref("receipt", item.receiptId),
        };
      case "missing_receipt":
        return {
          key: item.id,
          icon: Camera,
          title: item.party,
          amount: formatEur(Math.abs(item.amount)),
          amountTone: item.amount > 0 ? "positive" : "default",
          secondary: item.date ? `Kuitti puuttuu · ${formatDayMonth(item.date)}` : "Kuitti puuttuu",
          pill: "Kuvaa kuitti",
          blocking: true,
          href: "/pankki/tapahtumat?nayta=toimet",
          // FP-10: the verb is the effect. The camera opens and the photo is linked to this row.
          onAction: () => requestReceiptCapture({ transactionId: item.transactionId, label: item.party }),
        };
      case "receipt_match":
        return {
          key: item.id,
          icon: ArrowLeftRight,
          title: item.party,
          amount: formatEur(Math.abs(item.amount)),
          secondary: "Kohdistusehdotus · tarkista",
          pill: "Tarkista",
          blocking: true,
          href: "/pankki/tapahtumat?nayta=toimet",
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
          blocking: true,
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
          blocking: true,
          href: detailHref("invoice", item.invoiceId),
        };
      case "draft_invoice":
        return {
          key: item.id,
          icon: FilePen,
          title: item.party,
          amount: formatEur(item.amount),
          secondary: `Lasku ${item.number} · lähettämättä`,
          pill: "Avaa",
          blocking: true,
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
        readJson<DashboardData>(response, "Kodin tietojen lataus epäonnistui")
      )
      .then((data) => {
        if (cancelled) return;
        if (
          !Number.isFinite(data.income) ||
          !Number.isFinite(data.expenses) ||
          !data.vat
        ) {
          throw new Error("Palvelin palautti virheelliset Kodin tiedot");
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
  useRefetchOnReconnect(retry);

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
          return { kind, total, shown, blocking: isBlockingKind(kind) };
        })
        .filter((row) => row.total > row.shown)
    : [];
  // FP-2: the headline counts the blocking things to do, and equals the rows
  // under it (shown rows plus each "Näytä kaikki (N)").
  const hiddenBlocking = (data?.items ?? []).filter(
    (item) => hiddenItems.has(item.id) && isBlockingKind(item.kind)
  ).length;
  const blockingCount = data
    ? (data.blockingTotal ??
        (data.itemTotals
          ? (Object.entries(data.itemTotals) as Array<[ItemKind, number]>)
              .filter(([kind]) => isBlockingKind(kind))
              .reduce((sum, [, count]) => sum + count, 0)
          : visibleItems.filter((item) => isBlockingKind(item.kind)).length)) - hiddenBlocking
    : 0;
  const blockingTasks = itemTasks.filter((task) => task.blocking);
  const otherTasks = [...itemTasks.filter((task) => !task.blocking), ...accountTasks];
  const blockingMore = moreRows.filter((row) => row.blocking);
  const otherMore = moreRows.filter((row) => !row.blocking);
  const setup = atCurrent ? data?.setup : null;
  // TF-06: a new account starts from a checklist, never from "Kaikki kunnossa".
  const showSetup = Boolean(setup && (setup.empty || !setup.receipts || !setup.bank));
  const hasStatement = data?.source === "tiliote";
  const hasActivity = data ? kotiMonthHasActivity(data) : false;
  const headline = kotiHeadline({
    atCurrent,
    blockingCount,
    setupEmpty: Boolean(setup?.empty),
    otherOpen: otherTasks.length > 0 || otherMore.length > 0,
    hasActivity,
    hasStatement,
  });
  const statementLine = data
    ? kotiStatementLine({ atCurrent, hasActivity, hasStatement, setupEmpty: Boolean(setup?.empty) })
    : null;
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
  // FP-4 / TF-01: the current month shows the next return actually due (the
  // same row as Kirjanpito); a past month shows the return that month closes.
  const vatPastPeriod = atCurrent ? null : vatPeriodEndingIn(month, vatPeriodKindOf(profile?.vatPeriod));
  const vat = useVatDue(atCurrent || vatPastPeriod ? profile : null, vatPastPeriod);
  const vatHref = vat.due?.queryKey ? `/kirjanpito/alv?period=${vat.due.queryKey}` : "/kirjanpito/alv";
  const vatNote = vatPendingNote(vat.figures);
  const vatChanged = vatChangedNote(vat.figures);

  function openReceipt(receiptId: string) {
    const href = detailHref("receipt", receiptId);
    armNavigation(href.split("?")[0], "forward");
    router.push(href);
  }

  function renderTask(task: Task) {
    return (
      <div key={task.key} className={leaving.has(task.key) ? "row-leave" : undefined}>
      <ListRow
        href={task.onRowClick ? undefined : task.href}
        onClick={task.onRowClick}
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
      </div>
    );
  }

  function renderMore(row: { kind: ItemKind; total: number }) {
    return (
      <ListRow
        key={`more:${row.kind}`}
        href={KIND_LIST[row.kind].href}
        chevron
        title={`Näytä kaikki (${row.total})`}
        secondary={KIND_LIST[row.kind].label}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
      <PullToRefresh onRefresh={retry} />
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
          fallback={errorMessage(refreshFailed, "Kodin tietojen lataus epäonnistui")}
          onRetry={retry}
        />
      ) : !data ? (
        <KotiSkeleton />
      ) : (
        <div className={`space-y-6 ${fade}`}>
          {/* Month status: what is still open, how much of the bank is in order, VAT. */}
          <div className="rounded-card border border-line bg-surface p-4">
            <p className="text-headline font-semibold text-ink">{headline}</p>
            {matching && matching.matchable > 0 && !data.sectionErrors?.matching ? (
              <>
                <p className="mt-0.5 text-body text-ink-2">
                  {matching.matched} / {matching.matchable} pankkitapahtumaa kunnossa
                </p>
                <ProgressSegments done={matching.matched} total={matching.matchable} />
              </>
            ) : statementLine ? (
              <p className="mt-0.5 text-body text-ink-2">
                {statementLine}{" "}
                {/* F24: the file picker opens from this tap (it cannot open after a page change). */}
                <button
                  type="button"
                  onClick={requestStatementImport}
                  className="relative font-medium text-accent before:absolute before:inset-x-0 before:-inset-y-[12px] before:content-['']"
                >
                  Tuo tiliote
                </button>
              </p>
            ) : null}
            {/* FP-3: last month stays on Koti until it is closed. */}
            {atCurrent && data.previousMonth ? (
              <Link
                href={monthCloseHref(data.previousMonth.month)}
                className="active-press -mx-4 mt-4 flex min-h-12 items-center gap-3 border-t border-line px-4 py-3 text-body"
              >
                <Icon icon={CalendarCheck} className="shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1">
                  <span className="block text-ink">
                    {data.previousMonth.open > 0
                      ? `${monthNameOf(data.previousMonth.month)}: ${plural(data.previousMonth.open, "asia", "asiaa")} kesken`
                      : `${monthNameOf(data.previousMonth.month)} on valmis suljettavaksi`}
                  </span>
                  <span className="block text-caption text-ink-2">Kuukauden sulkeminen</span>
                </span>
                <Icon icon={ChevronRight} className="shrink-0 text-ink-2" />
              </Link>
            ) : null}
            {!atCurrent ? (
              <Link
                href={monthCloseHref(month)}
                className="active-press -mx-4 mt-4 flex min-h-12 items-center gap-3 border-t border-line px-4 py-3 text-body"
              >
                <Icon icon={CalendarCheck} className="shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1 text-ink">Kuukauden sulkeminen</span>
                <Icon icon={ChevronRight} className="shrink-0 text-ink-2" />
              </Link>
            ) : null}
            {vat.due ? (
              <Link
                href={vatHref}
                aria-label={`${VAT_ROW_TITLE}, ${vatDueSecondary(vat.due, vat.figures)}${vat.figures ? `, ${vatDueAmount(vat.figures)}` : ""}`}
                className="active-press -mx-4 -mb-4 mt-4 flex min-h-12 items-center justify-between gap-3 border-t border-line px-4 py-3 text-body"
              >
                <span className="min-w-0">
                  <span className="block text-ink">{VAT_ROW_TITLE}</span>
                  <span className="block text-caption text-ink-2">
                    {vat.waiting ? <Skeleton tone="soft" className="mt-1 h-3 w-40" /> : vatDueSecondary(vat.due, vat.figures)}
                  </span>
                  {vatChanged ? <span className="mt-0.5 block text-caption text-warning">{vatChanged}</span> : null}
                  {vatNote ? <span className="mt-0.5 block text-caption text-warning">{vatNote}</span> : null}
                </span>
                <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums text-ink">
                  {vat.waiting ? <Skeleton className="h-4 w-16" /> : vatDueAmount(vat.figures)}
                </span>
              </Link>
            ) : null}
          </div>

          {/* TF-06: the first steps of a new account. */}
          {showSetup && setup ? (
            <Section title="Aloitetaan">
              {[
                {
                  key: "receipt",
                  done: setup.receipts,
                  title: "Kuvaa ensimmäinen kuitti",
                  secondary: "Kuitti luetaan automaattisesti",
                  onClick: () => requestReceiptCapture(),
                },
                {
                  key: "bank",
                  done: setup.bank,
                  title: "Yhdistä pankki tai tuo tiliote",
                  secondary: "Tapahtumat kohdistetaan kuitteihin",
                  href: "/kirjanpito/pankkitilit",
                },
                {
                  key: "seller",
                  done: setup.seller,
                  title: "Täydennä laskuttajan tiedot",
                  secondary: "Nimi, Y-tunnus ja IBAN laskuille",
                  href: "/asetukset/laskutus",
                },
              ].map((step) => (
                <ListRow
                  key={step.key}
                  href={step.done ? undefined : step.href}
                  onClick={step.done ? undefined : step.onClick}
                  leading={<Icon icon={step.done ? CircleCheck : Circle} className={step.done ? "text-success" : "text-ink-2"} />}
                  title={step.title}
                  secondary={step.done ? "Valmis" : step.secondary}
                  chevron={!step.done}
                  ariaLabel={`${step.title}, ${step.done ? "valmis" : "tekemättä"}`}
                />
              ))}
            </Section>
          ) : null}

          {/* One card for every part that did not load, one retry (VS-31); the parts themselves are left out. */}
          <PartialFailureNotice messages={Object.values(data.sectionErrors ?? {})} onRetry={retry} />

          {blockingTasks.length > 0 || blockingMore.length > 0 ? (
            <Section title={atCurrent ? "Ennen kuun loppua" : "Kesken"}>
              {blockingTasks.map(renderTask)}
              {blockingMore.map(renderMore)}
            </Section>
          ) : null}

          {/* Not bookkeeping left undone: money to chase and account checks (FP-2). */}
          {otherTasks.length > 0 || otherMore.length > 0 ? (
            <Section title="Muut">
              {otherTasks.map(renderTask)}
              {otherMore.map(renderMore)}
            </Section>
          ) : null}

          <section>
            {/* One heading line: the basis belongs to the section, not to the Menot card below it. */}
            <h2 className="mb-2 px-1 text-caption font-normal text-ink-2">
              Kuukauden tulos
              {/* AX-11: VoiceOver joined the two parts ("tuloslaskujen") when the separator was its only gap. */}
              <span aria-hidden> · </span>
              <span className="sr-only">, </span>
              <span>{kotiResultBasis(documentsBasis ? "kuitit" : "tiliote", data.vat.registered)}</span>
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <Link href={tulotHref} aria-label={kotiResultLabel("Tulot", formatEur(data.income), data.vat.registered)} className="active-press block">
                <SummaryCard label="Tulot" value={formatEur(data.income)} />
              </Link>
              <Link href={menotHref} aria-label={kotiResultLabel("Menot", formatEur(data.expenses), data.vat.registered)} className="active-press block">
                <SummaryCard label="Menot" value={formatEur(data.expenses)} />
              </Link>
            </div>
          </section>

          {data.sectionErrors?.position ? null : (
            // F26: the balances and receivables are as of today, whichever month is shown.
            <Section title={atCurrent ? "Rahatilanne" : "Rahatilanne tänään"}>
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
                title="Avoimet myyntilaskut"
                amount={formatEur(data.receivables?.totalOpen ?? 0)}
                secondary={
                  data.receivables && data.receivables.overdue > 0
                    ? `${formatEur(data.receivables.overdue)} myöhässä`
                    : "Ei myöhässä olevia"
                }
                ariaLabel={`Avoimet myyntilaskut, ${formatEur(data.receivables?.totalOpen ?? 0)}`}
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
                  title="Avoimet ostolaskut"
                  amount={formatEur(data.payables.totalOpen)}
                  secondary={
                    data.payables.overdue > 0
                      ? `${formatEur(data.payables.overdue)} myöhässä`
                      : "Ei myöhässä olevia"
                  }
                  ariaLabel={`Avoimet ostolaskut, ${formatEur(data.payables.totalOpen)}`}
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
                    : "Tiliotteen tapahtumat, joilla on kuitti"
                }
              />
            </Section>
          ) : null}

          {data.sectionErrors?.threshold ? null : !data.vat.registered && data.vat.ytdRevenue >= data.vat.threshold * 0.75 ? (
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
      <ReceiptApprovalSheet
        receipt={approvalTarget}
        onClose={() => setApprovalTarget(null)}
        onApprove={() => {
          const target = approvalTarget;
          setApprovalTarget(null);
          if (target) approveReceipt(target);
        }}
        onEdit={(receipt) => {
          setApprovalTarget(null);
          openReceipt(receipt.receiptId);
        }}
      />
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
