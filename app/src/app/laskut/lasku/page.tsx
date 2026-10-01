"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDate, formatDayMonth, formatEur, parseMoneyInput } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { helsinkiCalendarDate } from "@/lib/validation";
import { formatReference } from "@/lib/finnish-reference";
import { copyToClipboard } from "@/lib/clipboard";
import { CopyButton } from "@/components/ds/CopyButton";
import { shareContent } from "@/lib/share";
import { openAuthedFile } from "@/lib/authed-file";
import { AuthedFileLink } from "@/components/AuthedFileLink";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { daysOverdue, vatForNet } from "@/lib/invoices";
import { SALES_STATUS } from "@/lib/status-labels";
import { detailHref } from "@/lib/routes";
import { Button, buttonClass, controlClass, Field } from "@/components/ui";
import { Bell } from "lucide-react";
import {
  BottomActions,
  DetailHero,
  Icon,
  KeyValueList,
  ListRow,
  MoreMenu,
  Section,
  Skeleton,
  SkeletonCard,
  SkeletonGroup,
  StatusTag,
  Timeline,
  useSkeletonFade,
} from "@/components/ds";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";
import { ReminderSheet, type ReminderPreview } from "@/components/invoices/ReminderSheet";
import { reminderWaitNote } from "@/lib/reminder-schedule";
import { overOpenMessage } from "@/lib/payment-entry";
import { sendAttemptView } from "@/lib/send-history";

/** A hand-recorded payment that an income receipt from a bank row seems to count again. */
interface PaymentDuplicate {
  receiptId: string;
  receiptVendor: string | null;
  receiptDate: string | null;
  amountCents: number;
  transactionId: string;
  paymentId: string;
  paidDate: string;
}

/** An incoming bank row the payment being recorded most likely is. */
interface BankRowCandidate {
  transactionId: string;
  date: string | null;
  counterparty: string | null;
  amount: number;
  hasReceipt: boolean;
}

interface SendPreview {
  recipient: string | null;
  gross: number;
  dueDate: string | null;
  iban: string | null;
  creditNote?: boolean;
  attachment: string;
  missing: string[];
  blockedReason: string | null;
}

interface Invoice {
  id: string;
  number: number;
  reference: string;
  status: "draft" | "sent" | "paid" | "credited";
  displayStatus: "draft" | "sent" | "paid" | "credited" | "overdue";
  documentKind?: "invoice" | "credit_note";
  creditsInvoice?: { id: string; number: number } | null;
  creditNotes?: Array<{ id: string; number: number; status: string }>;
  issueDate: string;
  dueDate: string;
  notes: string | null;
  net: number;
  vat: number;
  gross: number;
  paid: number;
  open: number;
  closedReason: string | null;
  customer: { id: string; name: string; email: string | null; businessId: string | null };
  lines: Array<{
    id: string;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    vatRate: number;
    net: number;
  }>;
  payments: Array<{
    id: string;
    paidDate: string;
    amount: number;
    source: string;
    note: string | null;
  }>;
  sends?: Array<{
    id: string;
    toAddress: string;
    status: string;
    attachmentName: string | null;
    gross: number | null;
    error: string | null;
    createdAt: string;
    finishedAt: string | null;
  }>;
  activity?: Array<{ id: string; kind: string; summary: string; createdAt: string }>;
}

/** Same name the server and the mail attachment use: lasku-0007.pdf, hyvitys-0018.pdf. */
function pdfFileName(invoice: Pick<Invoice, "number" | "documentKind">): string {
  const prefix = invoice.documentKind === "credit_note" ? "hyvitys" : "lasku";
  return `${prefix}-${String(invoice.number).padStart(4, "0")}.pdf`;
}

/** One row per distinct VAT rate present on the invoice's lines. */
function vatBreakdown(lines: Invoice["lines"]): Array<{ rate: number; net: number; vat: number }> {
  const byRate = new Map<number, number>();
  for (const line of lines) {
    byRate.set(line.vatRate, (byRate.get(line.vatRate) ?? 0) + line.net);
  }
  return [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    // Same cent rounding as the server and the PDF; a plain (net * rate) / 100
    // gives -0 for a 0 % row of a credit note.
    .map(([rate, net]) => ({
      rate,
      net,
      vat: vatForNet(Math.round(net * 100), Math.round(rate * 10)) / 100,
    }));
}

type HistoryItem = { title: string; meta?: string; tone?: "accent" | "muted" };

/** "Historia": the invoice's activity log and send attempts merged into one feed, newest first. */
function historyItems(invoice: Invoice): HistoryItem[] {
  const dated: Array<HistoryItem & { at: number }> = [];

  if (invoice.displayStatus === "overdue") {
    dated.push({
      title: "Erääntyi",
      meta: formatDayMonth(invoice.dueDate),
      tone: "accent",
      at: new Date(invoice.dueDate).getTime(),
    });
  }

  for (const send of invoice.sends ?? []) {
    const view = sendAttemptView(send);
    // Never the raw SMTP text (L5): it is English and internal.
    const metaParts = [
      formatDate(send.createdAt),
      send.toAddress,
      send.attachmentName,
      send.gross != null ? formatEur(send.gross) : null,
      view.reason,
    ].filter((part): part is string => Boolean(part));
    dated.push({
      title: view.title,
      meta: metaParts.join(", "),
      tone: view.tone,
      at: new Date(send.createdAt).getTime(),
    });
  }

  for (const entry of invoice.activity ?? []) {
    dated.push({
      title: entry.summary,
      meta: formatDate(entry.createdAt),
      tone: "muted",
      at: new Date(entry.createdAt).getTime(),
    });
  }

  return dated
    .sort((a, b) => b.at - a.at)
    .map(({ title, meta, tone }) => ({ title, meta, tone }));
}

/** "2 h × 100,00 €", Finnish decimals. */
function lineQuantity(line: Invoice["lines"][number]): string {
  const quantity = String(line.quantity).replace(".", ",");
  return `${quantity} ${line.unit} × ${formatEur(line.unitPrice)}`;
}

/** Open balance for the payment field: always two decimals ("125,50", not "125,5"). */
function amountText(value: number): string {
  return value > 0 ? value.toFixed(2).replace(".", ",") : "";
}

/** The detail at its final layout: hero, the key facts, the lines (L1, SALES-19). */
function InvoiceSkeleton() {
  return (
    <SkeletonGroup label="Ladataan laskua" className="space-y-6">
      <div className="flex flex-col items-center px-2 pb-5 pt-2">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="mt-3 h-4 w-32" />
        <Skeleton tone="soft" className="mt-2 h-3.5 w-48" />
        <Skeleton radius="full" className="mt-4 h-7 w-24" />
      </div>
      <SkeletonCard className="space-y-4">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex justify-between gap-6">
            <Skeleton tone="soft" className="h-3.5 w-20" />
            <Skeleton className="h-3.5 w-24" />
          </div>
        ))}
      </SkeletonCard>
      <SkeletonCard className="space-y-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton tone="soft" className="h-3 w-1/3" />
      </SkeletonCard>
    </SkeletonGroup>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<InvoiceSkeleton />}>
      <InvoiceDetail />
    </Suspense>
  );
}

function InvoiceDetail() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();

  // Task 7-style instant paint: a cached copy renders immediately while
  // `load()` (below) confirms or refreshes it in the background.
  const cachedInvoice = id ? readPageCache<Invoice>(`invoice:${id}`) : null;
  const [invoice, setInvoice] = useState<Invoice | null>(cachedInvoice);
  const [state, setState] = useState<"loading" | "ready" | "error">(cachedInvoice ? "ready" : "loading");
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton.
  const lateInvoice = useCacheAfterBoot<Invoice>(id ? `invoice:${id}` : null);
  const [appliedLateInvoice, setAppliedLateInvoice] = useState<Invoice | null>(null);
  if (lateInvoice && lateInvoice !== appliedLateInvoice && state === "loading") {
    setAppliedLateInvoice(lateInvoice);
    setInvoice(lateInvoice);
    setState("ready");
  }
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => helsinkiCalendarDate());
  const paymentKey = useRef(newIdempotencyKey());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemovePayment, setConfirmRemovePayment] = useState<string | null>(null);
  const [review, setReview] = useState<SendPreview | null>(null);
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [reminder, setReminder] = useState<ReminderPreview | null>(null);
  const [reminderLoadFailed, setReminderLoadFailed] = useState(false);
  const [reminderRetrying, setReminderRetrying] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closeReasonOpen, setCloseReasonOpen] = useState(false);
  const [closeReasonError, setCloseReasonError] = useState("");
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  const [sendError, setSendError] = useState("");
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [confirmCredit, setConfirmCredit] = useState(false);
  const [confirmMarkSent, setConfirmMarkSent] = useState(false);
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [paymentDuplicates, setPaymentDuplicates] = useState<PaymentDuplicate[]>([]);
  const [duplicateBusy, setDuplicateBusy] = useState<string | null>(null);
  const [bankRow, setBankRow] = useState<BankRowCandidate | null>(null);
  const [useBankRow, setUseBankRow] = useState(true);

  // The reminder preview only exists for an invoice that is genuinely
  // overdue; a 409 here is the expected answer, not an error to show. A
  // network/500 failure is different: it must leave a usable control behind
  // (see reminderLoadFailed), not a permanently disabled button, so it's
  // tracked separately from "haven't heard back yet".
  const loadReminderPreview = useCallback(async () => {
    try {
      const preview = await apiFetch(`/api/invoices/${id}/reminders`, { credentials: "include" });
      const previewData = await readJson<{ reminder: ReminderPreview }>(preview, "");
      setReminder(previewData.reminder);
      setReminderLoadFailed(false);
    } catch {
      setReminder(null);
      setReminderLoadFailed(true);
    }
  }, [id]);

  async function retryReminderPreview() {
    setReminderRetrying(true);
    await loadReminderPreview();
    setReminderRetrying(false);
  }

  const load = useCallback(async () => {
    if (!id) {
      setMessage("Laskua ei löytynyt.");
      setState("error");
      return;
    }
    try {
      const response = await apiFetch(`/api/invoices/${id}`, { credentials: "include" });
      const data = await readJson<{ invoice: Invoice; paymentDuplicates?: PaymentDuplicate[] }>(
        response,
        "Laskun haku epäonnistui"
      );
      setInvoice(data.invoice);
      setPaymentDuplicates(data.paymentDuplicates ?? []);
      setPaymentAmount(amountText(data.invoice.open));
      setState("ready");
      setRefreshFailed(false);
      setLoadFailure(null);
      writePageCache(`invoice:${id}`, data.invoice);

      if (data.invoice.displayStatus === "overdue") {
        await loadReminderPreview();
      } else {
        setReminder(null);
        setReminderLoadFailed(false);
      }
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      // A cached copy already on screen stays up rather than being
      // replaced by the error screen, but it says so (SALES-28): money
      // actions wait until the invoice is current again.
      setLoadFailure(error);
      if (readPageCache<Invoice>(`invoice:${id}`)) {
        setRefreshFailed(true);
        return;
      }
      setState("error");
    }
  }, [id, loadReminderPreview]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  // Recording a payment by hand: offer the incoming bank row with the same
  // amount and a nearby date, so the money is not counted a second time
  // through an income receipt drafted from that row.
  useEffect(() => {
    if (!paymentSheetOpen || !id) return;
    const amount = parseMoneyInput(paymentAmount);
    if (amount === null || amount <= 0 || !paymentDate) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ amount: String(amount), paidDate: paymentDate });
      apiFetch(`/api/invoices/${id}/payments/candidates?${query}`, { credentials: "include" })
        .then((response) => readJson<{ candidates: BankRowCandidate[] }>(response, ""))
        .then((data) => {
          if (!cancelled) setBankRow(data.candidates[0] ?? null);
        })
        // The offer is a convenience; without it the payment is still recorded.
        .catch(() => {
          if (!cancelled) setBankRow(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [paymentSheetOpen, id, paymentAmount, paymentDate]);

  async function changeStatus(status: Invoice["status"], reason?: string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/status`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { status, closeReason: reason } : { status }),
      });
      await readJson(response, "Tilan vaihto epäonnistui");
      setCloseReason("");
      await load();
      return true;
    } catch (error) {
      setMessage(errorMessage(error, "Tilan vaihto epäonnistui"));
      void hapticNotify("error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Reversible, so no dialog: done at once, with "Kumoa" for a few seconds (T4). */
  async function markPaid() {
    const ok = await changeStatus("paid");
    if (!ok) return;
    // ToastHost buzzes for a success toast; a second haptic here doubled it.
    showToast({
      tone: "success",
      text: "Lasku merkittiin maksetuksi",
      action: {
        label: "Kumoa",
        onAction: () => {
          void changeStatus("sent").then((undone) => {
            if (undone) showToast({ text: "Lasku on taas avoin" });
          });
        },
      },
    });
  }

  function closeWithReason() {
    const reason = closeReason.trim();
    if (reason.length < 3) {
      setCloseReasonError("Kirjoita perustelu, vähintään kolme merkkiä.");
      return;
    }
    setCloseReasonError("");
    setCloseReasonOpen(false);
    void changeStatus("paid", reason);
  }

  async function addPayment() {
    const amount = parseMoneyInput(paymentAmount);
    if (!paymentAmount.trim() || amount === null) {
      setPaymentError(
        paymentAmount.trim() ? "Summa ei ole kelvollinen." : "Anna maksun summa, esim. 125,50."
      );
      document.getElementById("payment-amount")?.focus();
      return;
    }
    if (amount <= 0) {
      setPaymentError("Summa ei voi olla negatiivinen tai nolla.");
      document.getElementById("payment-amount")?.focus();
      return;
    }
    if (paymentDate > helsinkiCalendarDate()) {
      setPaymentError("Maksupäivä ei voi olla tulevaisuudessa.");
      return;
    }
    // The server refuses a hand-keyed payment above the open balance, so the
    // sheet says so on the first tap instead of offering a second tap that fails.
    const tooMuch = invoice ? overOpenMessage(amount, invoice.open, Boolean(bankRow && useBankRow)) : null;
    if (tooMuch) {
      setPaymentError(tooMuch);
      document.getElementById("payment-amount")?.focus();
      return;
    }
    setPaymentError("");
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/payments`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": paymentKey.current,
        },
        body: JSON.stringify({
          amount,
          paidDate: paymentDate,
          // The user kept the offered bank row: the payment carries it, so an
          // income receipt from that row is never counted on top.
          ...(bankRow && useBankRow ? { transactionId: bankRow.transactionId } : {}),
        }),
      });
      await readJson(response, "Maksun kirjaus epäonnistui");
      paymentKey.current = newIdempotencyKey();
      setPaymentAmount("");
      setPaymentSheetOpen(false);
      showToast({ tone: "success", text: `Maksu ${formatEur(amount)} kirjattiin` });
      await load();
    } catch (error) {
      // Server errors surface inside the sheet the user is looking at, same
      // as validation errors just above - not the page-level message, which
      // renders behind the sheet's backdrop and is effectively invisible.
      setPaymentError(errorMessage(error, "Maksun kirjaus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  /** Opens the payment sheet with a clean slate: no stale error, amount reset to the current open balance. */
  function openPaymentSheet() {
    if (!invoice) return;
    setBankRow(null);
    setUseBankRow(true);
    setPaymentError("");
    setPaymentAmount(amountText(invoice.open));
    setPaymentDate(helsinkiCalendarDate());
    setPaymentSheetOpen(true);
  }

  async function settleDuplicate(pair: PaymentDuplicate, action: "link" | "dismiss") {
    setDuplicateBusy(pair.paymentId);
    try {
      const response = await apiFetch(`/api/invoices/${id}/payments/link`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "link"
            ? { action, paymentId: pair.paymentId, transactionId: pair.transactionId }
            : { action, paymentId: pair.paymentId, receiptId: pair.receiptId }
        ),
      });
      await readJson(response, "Tallennus epäonnistui");
      showToast({
        tone: "success",
        text: action === "link" ? "Maksu yhdistettiin tilitapahtumaan" : "Merkitty erillisiksi tuloiksi",
      });
      await load();
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Tallennus epäonnistui") });
    } finally {
      setDuplicateBusy(null);
    }
  }

  async function removePayment(paymentId: string) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/invoices/${id}/payments?paymentId=${paymentId}`, {
        method: "DELETE",
        credentials: "include",
      });
      await readJson(response, "Maksun poisto epäonnistui");
      await load();
    } catch (error) {
      const message = errorMessage(error, "Maksun poisto epäonnistui");
      setMessage(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function shareInvoice() {
    if (!invoice || sharing) return;
    setSharing(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${invoice.id}/pdf`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("PDF:n haku epäonnistui");
      const blob = await response.blob();
      const file = new File([blob], pdfFileName(invoice), {
        type: blob.type || "application/pdf",
      });
      const result = await shareContent({
        title: `Lasku ${invoice.number}`,
        text: `Lasku ${invoice.number}`,
        // On mobile, window.location.href is a capacitor://localhost URL --
        // meaningless to whoever receives the share, so it is dropped there.
        url: IS_MOBILE_BUILD ? undefined : window.location.href,
        file,
      });
      if (result === "downloaded") setMessage("PDF ladattiin laitteelle.");
      if (result === "unavailable") {
        setMessage("Jakaminen ei ole käytettävissä tällä laitteella.");
      }
    } catch (error) {
      setMessage(errorMessage(error, "Jakaminen epäonnistui"));
    } finally {
      setSharing(false);
    }
  }

  async function openReview() {
    setSending(true);
    setMessage(null);
    setSendError("");
    try {
      const response = await apiFetch(`/api/invoices/${id}/send`, { credentials: "include" });
      const result = await readJson<{ preview: SendPreview }>(response, "Tarkistuksen haku epäonnistui");
      setReview(result.preview);
    } catch (error) {
      setMessage(errorMessage(error, "Tarkistuksen haku epäonnistui"));
    } finally {
      setSending(false);
    }
  }

  async function createCreditNote() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/credit`, {
        method: "POST",
        credentials: "include",
      });
      const result = await readJson<{ invoice: { id: string; number: number } }>(response, "Hyvitys epäonnistui");
      showToast({ tone: "success", text: `Hyvityslasku ${result.invoice.number} luotiin` });
      router.push(detailHref("invoice", result.invoice.id));
    } catch (error) {
      // ConfirmModal shows the failure inside the dialog.
      throw new Error(errorMessage(error, "Hyvitys epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function duplicateInvoice() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/duplicate`, {
        method: "POST",
        credentials: "include",
      });
      const result = await readJson<{ invoice: { id: string; number: number } }>(response, "Kopiointi epäonnistui");
      showToast({ tone: "success", text: `Luonnos ${result.invoice.number} luotiin` });
      router.push(detailHref("invoice", result.invoice.id));
    } catch (error) {
      setMessage(errorMessage(error, "Kopiointi epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function sendByEmail() {
    setSending(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/send`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await readJson<{ sentTo: string; recorded?: boolean; notice?: string | null }>(
        response,
        "Lähetys epäonnistui"
      );
      if (result.recorded === false) {
        setMessage(
          result.notice ??
            "Viesti lähti, mutta lähetyksen kirjausta ei saatu tallennettua. Älä lähetä samaa laskua uudelleen ennen tarkistusta."
        );
      } else {
        setMessage(`Lasku lähetettiin osoitteeseen ${result.sentTo}.`);
      }
      setReview(null);
      await load();
    } catch (error) {
      // Same as addPayment: this renders inside the "Lähetä lasku" sheet
      // (which stays open), not the page-level message behind it.
      setSendError(errorMessage(error, "Lähetys epäonnistui"));
    } finally {
      setSending(false);
    }
  }

  async function deleteInvoice() {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/invoices/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await readJson(response, "Poisto epäonnistui");
      router.push("/laskut");
    } catch (error) {
      const message = errorMessage(error, "Poisto epäonnistui");
      setMessage(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  const fade = useSkeletonFade(state === "loading");

  // Exactly one primary action per status; the rarer actions live in the "..." menu instead.
  // Plain data only (no closures): the onClick a given kind maps to is wired up
  // directly at the JSX call site below, one handler per kind, so the actual
  // function value (and whatever ref it touches, e.g. addPayment's idempotency
  // key) is created inline at render time exactly like every other button on
  // this page, rather than stored on this object and read back out of it.
  type PrimaryKind = "send" | "remind" | "retryReminder" | "markPaid" | "pay";
  type PrimaryAction = { kind: PrimaryKind; label: string; busy: boolean; busyLabel?: string; icon?: boolean };
  const primary: PrimaryAction | null = (() => {
    if (!invoice) return null;
    // A credit note is settled by the credit itself: nothing to collect.
    if (invoice.documentKind === "credit_note") return null;
    if (invoice.status === "draft") {
      return { kind: "send", label: "Lähetä", busy: sending, busyLabel: "Tarkistetaan…" };
    }
    // Nothing left to collect takes priority over the overdue reminder flow,
    // even on an invoice that is technically still "overdue" by date.
    if (invoice.status === "sent" && invoice.open <= 0) {
      return { kind: "markPaid", label: "Merkitse maksetuksi", busy: false };
    }
    if (invoice.displayStatus === "overdue") {
      // A genuine load failure (not just "still in flight") must leave a
      // usable, enabled control - tapping it retries the preview fetch,
      // rather than stranding the user behind a button disabled forever.
      if (reminderLoadFailed) {
        return {
          kind: "retryReminder",
          label: "Yritä uudelleen",
          busy: reminderRetrying,
          busyLabel: "Ladataan…",
          icon: true,
        };
      }
      // The reminder preview (fee/total) loads after the invoice itself; the
      // button stays disabled with a loading label until it's here, rather
      // than letting a tap fire the actual send before the numbers are known.
      const loading = !reminder;
      return {
        kind: "remind",
        label: "Lähetä muistutus",
        busy: loading,
        busyLabel: "Ladataan…",
        icon: true,
      };
    }
    if (invoice.status === "sent") {
      return { kind: "pay", label: "Kirjaa maksu", busy: false };
    }
    return null;
  })();

  // A new reminder is certain to be refused while the last one's term runs.
  const reminderWait = reminderWaitNote(reminder);

  const menuItems = invoice
    ? [
        ...(invoice.status === "draft"
          ? [
              {
                label: "Muokkaa",
                onSelect: () => router.push(`/laskut/uusi?edit=${encodeURIComponent(invoice.id)}`),
                disabled: busy,
              },
            ]
          : []),
        {
          label: pdfBusy ? "Avataan PDF…" : "Avaa PDF",
          disabled: pdfBusy,
          onSelect: () => {
            if (pdfBusy) return;
            setPdfBusy(true);
            void openAuthedFile(
              `/api/invoices/${invoice.id}/pdf`,
              pdfFileName(invoice),
              `Lasku ${invoice.number}`
            )
              .catch((error: unknown) =>
                showToast({ tone: "error", text: errorMessage(error, "Tiedoston avaus epäonnistui") })
              )
              .finally(() => setPdfBusy(false));
          },
        },
        { label: "Jaa", onSelect: () => void shareInvoice(), disabled: busy || sharing },
        // AX-07, R25: the reference the customer pays with can be copied.
        // A credit note is not paid, so it has none.
        ...(invoice.reference && invoice.documentKind !== "credit_note"
          ? [
              {
                label: "Kopioi viitenumero",
                onSelect: () => void copyToClipboard(formatReference(invoice.reference), "Viitenumero"),
              },
            ]
          : []),
        ...(invoice.status !== "credited"
          ? [{ label: "Lähetä sähköpostilla", onSelect: () => void openReview(), disabled: busy || sending }]
          : []),
        { label: "Kopioi luonnokseksi", onSelect: () => void duplicateInvoice(), disabled: busy },
        ...(invoice.documentKind !== "credit_note" &&
        invoice.status !== "credited" &&
        invoice.status !== "draft"
          ? [{ label: "Hyvitä", onSelect: () => setConfirmCredit(true), disabled: busy || refreshFailed }]
          : []),
        ...(invoice.status === "draft"
          ? [
              {
                label: "Merkitse lähetetyksi (ilman sähköpostia)",
                onSelect: () => setConfirmMarkSent(true),
                disabled: busy,
              },
            ]
          : []),
        ...(invoice.status === "sent" && invoice.open > 0
          ? [
              {
                label: "Sulje perustelulla",
                onSelect: () => {
                  setCloseReasonError("");
                  setCloseReasonOpen(true);
                },
              },
            ]
          : []),
        ...(invoice.status === "draft"
          ? [
              {
                label: "Poista luonnos",
                onSelect: () => setConfirmDelete(true),
                tone: "danger" as const,
                disabled: busy,
              },
            ]
          : []),
      ]
    : [];

  return (
    <>
      <div className="space-y-6">
        {state === "loading" && <InvoiceSkeleton />}
        {state === "error" && (
          <ConnectionNotice
            error={loadFailure}
            fallback={id ? "Laskun haku epäonnistui" : "Laskua ei löytynyt."}
            onRetry={() => {
              setState("loading");
              void load();
            }}
          />
        )}

        {state === "ready" && invoice && (
          <div className={`space-y-6 ${fade}`}>
            {refreshFailed && (
              <StaleBanner
                fetchedAt={pageCacheFetchedAt(`invoice:${id}`)}
                onRetry={() => void load()}
              />
            )}
            <DetailHero
              amount={formatEur(invoice.gross)}
              title={invoice.customer.name}
              meta={
                <>
                  <span className="block">
                    {invoice.documentKind === "credit_note"
                      ? `Hyvityslasku ${invoice.number}`
                      : `Lasku ${invoice.number}, viite ${formatReference(invoice.reference)}`}
                  </span>
                  {invoice.creditsInvoice && (
                    <span className="block">Hyvittää laskun {invoice.creditsInvoice.number}</span>
                  )}
                  {invoice.creditNotes && invoice.creditNotes.length > 0 && (
                    <span className="block">
                      Hyvityslasku {invoice.creditNotes.map((note) => note.number).join(", ")}
                    </span>
                  )}
                  <span className="block">
                    <Link
                      href={detailHref("customer", invoice.customer.id)}
                      className="relative text-accent before:absolute before:-inset-x-3 before:-inset-y-[14px] before:content-['']"
                    >
                      Asiakas
                    </Link>
                    {invoice.customer.businessId ? ` · ${invoice.customer.businessId}` : ""}
                  </span>
                </>
              }
              status={
                invoice.documentKind === "credit_note" ? (
                  <StatusTag tone="neutral">Hyvityslasku</StatusTag>
                ) : (
                <StatusTag tone={SALES_STATUS[invoice.displayStatus].tone}>
                  {invoice.displayStatus === "overdue"
                    ? `Myöhässä ${daysOverdue(invoice.dueDate)} päivää`
                    : SALES_STATUS[invoice.displayStatus].label}
                </StatusTag>
                )
              }
              menu={<MoreMenu items={menuItems} />}
            />

            {message && (
              <p className="rounded-card bg-accent-soft px-4 py-3 text-caption text-ink" role="status">
                {message}
              </p>
            )}

            <KeyValueList
              rows={[
                { label: "Päivätty", value: formatDate(invoice.issueDate) },
                ...(invoice.documentKind === "credit_note"
                  ? []
                  : [
                      { label: "Eräpäivä", value: formatDate(invoice.dueDate) },
                      {
                        label: "Viite",
                        value: formatReference(invoice.reference),
                        ...(invoice.reference
                          ? { copy: { text: formatReference(invoice.reference), what: "Viitenumero" } }
                          : {}),
                      },
                    ]),
                { label: "Veroton", value: formatEur(invoice.net) },
                ...vatBreakdown(invoice.lines).map((row) => ({
                  label: `ALV ${String(row.rate).replace(".", ",")} %`,
                  value: formatEur(row.vat),
                })),
                { label: "Yhteensä", value: formatEur(invoice.gross) },
                ...(invoice.payments.length > 0
                  ? [{ label: "Maksettu", value: formatEur(invoice.paid) }]
                  : []),
                ...(invoice.closedReason
                  ? [{ label: "Suljettu", value: invoice.closedReason }]
                  : []),
              ]}
            />

            {invoice.lines.length > 0 && (
              <Section title="Rivit">
                {invoice.lines.map((line) => (
                  <ListRow
                    key={line.id}
                    title={line.description}
                    amount={formatEur(line.net)}
                    secondary={`${lineQuantity(line)} · ALV ${String(line.vatRate).replace(".", ",")} %`}
                  />
                ))}
              </Section>
            )}

            {invoice.documentKind !== "credit_note" &&
              (invoice.payments.length > 0 ||
              invoice.status === "sent" ||
              invoice.status === "paid") && (
              <Section
                title="Maksut"
                action={
                  invoice.open > 0 ? (
                    <span className="tabular-nums">{formatEur(invoice.open)} avoinna</span>
                  ) : undefined
                }
              >
                {invoice.payments.length === 0 ? (
                  <p className="px-4 py-4 text-body text-ink-2">Ei maksuja vielä.</p>
                ) : (
                  invoice.payments.map((payment) => (
                    <div key={payment.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div>
                        <p className="text-body text-ink">{formatEur(payment.amount)}</p>
                        <p className="text-caption text-ink-2">
                          {formatDate(payment.paidDate)}
                          {payment.source === "bank" ? " · pankista" : ""}
                          {payment.note ? ` · ${payment.note}` : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setConfirmRemovePayment(payment.id)}
                        disabled={busy}
                      >
                        Poista
                      </Button>
                    </div>
                  ))
                )}
              </Section>
            )}

            {paymentDuplicates.length > 0 && (
              <Section title="Tarkista maksu">
                {paymentDuplicates.map((pair) => (
                  <div key={`${pair.receiptId}:${pair.paymentId}`} className="space-y-3 px-4 py-4">
                    <p className="text-body text-ink">
                      Tulokuitti{pair.receiptVendor ? ` ${pair.receiptVendor}` : ""}{" "}
                      {formatEur(pair.amountCents / 100)}
                      {pair.receiptDate ? ` (${formatDate(pair.receiptDate)})` : ""} on kirjattu
                      tiliotteen maksusta, joka näyttää samalta kuin tämä maksu{" "}
                      {formatDate(pair.paidDate)}. Molemmat lasketaan nyt tuloiksi.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        className="flex-1"
                        busy={duplicateBusy === pair.paymentId}
                        busyLabel="Yhdistetään…"
                        disabled={duplicateBusy !== null || refreshFailed}
                        onClick={() => void settleDuplicate(pair, "link")}
                      >
                        Sama maksu, yhdistä
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        className="flex-1"
                        disabled={duplicateBusy !== null || refreshFailed}
                        onClick={() => void settleDuplicate(pair, "dismiss")}
                      >
                        Eri tuloja
                      </Button>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {reminder && (
              <Section title="Muistutukset">
                <div className="space-y-3 px-4 py-4">
                  <p className="text-caption text-ink-2">
                    Myöhässä {reminder.daysLate} päivää · muistutus {reminder.level}
                  </p>
                  <div className="space-y-1 text-body">
                    <div className="flex justify-between text-ink-2">
                      <span>Avoin pääoma</span>
                      <span>{formatEur(reminder.open)}</span>
                    </div>
                    {reminder.interest > 0 && (
                      <div className="flex justify-between text-ink-2">
                        <span>Viivästyskorko</span>
                        <span>{formatEur(reminder.interest)}</span>
                      </div>
                    )}
                    {reminder.fee > 0 && (
                      <div className="flex justify-between text-ink-2">
                        <span>Muistutusmaksu</span>
                        <span>{formatEur(reminder.fee)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-semibold text-ink">
                      <span>Maksettava yhteensä</span>
                      <span>{formatEur(reminder.total)}</span>
                    </div>
                  </div>
                  <AuthedFileLink
                    href={`/api/invoices/${invoice.id}/reminders/pdf`}
                    fallbackName={`muistutus-${invoice.number}.pdf`}
                    title={`Muistutus, lasku ${invoice.number}`}
                    className={buttonClass("secondary")}
                  >
                    Avaa muistutus
                  </AuthedFileLink>
                  {reminderWait && (
                    <p className="text-caption text-ink-2" role="status">
                      {reminderWait}
                    </p>
                  )}
                  {reminder.previousReminders.length > 0 && (
                    <ul className="space-y-1 text-caption text-ink-2">
                      {reminder.previousReminders.map((previous) => (
                        <li key={`${previous.level}-${previous.sentAt}`}>
                          Muistutus {previous.level} · {formatDate(previous.sentAt.slice(0, 10))} ·{" "}
                          {formatEur(previous.total)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Section>
            )}

            <section className="mt-6">
              <h2 className="mb-2 px-1 text-caption font-normal text-ink-2">Historia</h2>
              <Timeline items={historyItems(invoice)} />
            </section>

            {invoice.notes && (
              <Section title="Viesti laskulla">
                <p className="whitespace-pre-wrap px-4 py-4 text-body text-ink">{invoice.notes}</p>
              </Section>
            )}
          </div>
        )}
      </div>

      {state === "ready" && invoice && primary && (
        <BottomActions>
          {invoice.displayStatus === "overdue" && invoice.open > 0 && (
            <button
              type="button"
              disabled={refreshFailed}
              className="active-press flex min-h-12 w-full items-center justify-center text-body font-semibold text-accent disabled:opacity-50"
              onClick={() => openPaymentSheet()}
            >
              Kirjaa maksu
            </button>
          )}
          {invoice.status === "draft" && (
            <button
              type="button"
              className="active-press flex min-h-12 w-full items-center justify-center text-body font-semibold text-accent"
              onClick={() => router.push(`/laskut/uusi?edit=${encodeURIComponent(invoice.id)}`)}
            >
              Muokkaa
            </button>
          )}
          <Button
            type="button"
            className="w-full"
            busy={primary.busy}
            busyLabel={primary.busyLabel}
            disabled={
              busy || (refreshFailed && primary.kind !== "send") || (primary.kind === "remind" && reminderWait !== null)
            }
            disabledReason={
              refreshFailed
                ? "Lasku ei ole ajan tasalla. Päivitä ensin."
                : primary.kind === "remind"
                  ? (reminderWait ? "Uusi muistutus ei ole vielä mahdollinen" : undefined)
                  : undefined
            }
            onClick={
              primary.kind === "send"
                ? () => void openReview()
                : primary.kind === "remind"
                  ? () => setReminderSheetOpen(true)
                  : primary.kind === "retryReminder"
                    ? () => void retryReminderPreview()
                    : primary.kind === "markPaid"
                      ? () => void markPaid()
                      : () => openPaymentSheet()
            }
          >
            {primary.icon ? <Icon icon={Bell} size="inline" /> : null}
            {primary.label}
          </Button>
        </BottomActions>
      )}

      <ConfirmModal
        isOpen={confirmDelete}
        title="Poistetaanko luonnos?"
        description="Luonnos poistetaan pysyvästi."
        confirmLabel="Poista"
        onConfirm={() => deleteInvoice()}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmModal
        isOpen={confirmCredit}
        title="Luodaanko hyvityslasku?"
        description={
          invoice
            ? `Laskulle ${invoice.number} luodaan numeroitu hyvityslasku koko summasta ${formatEur(invoice.gross)}. Hyvitystä ei voi perua.`
            : undefined
        }
        confirmLabel="Hyvitä"
        onConfirm={() => createCreditNote()}
        onCancel={() => setConfirmCredit(false)}
      />

      <ConfirmModal
        isOpen={confirmMarkSent}
        title="Merkitäänkö lähetetyksi?"
        description="Lasku kirjataan lähetetyksi, mutta sähköpostia ei lähetetä. Käytä tätä, jos toimitit laskun muuten, esimerkiksi paperilla."
        confirmLabel="Merkitse"
        isDestructive={false}
        onConfirm={async () => {
          const ok = await changeStatus("sent");
          if (!ok) throw new Error("Tilan vaihto epäonnistui");
          showToast({ tone: "success", text: "Lasku merkittiin lähetetyksi" });
        }}
        onCancel={() => setConfirmMarkSent(false)}
      />

      <ConfirmModal
        isOpen={confirmRemovePayment !== null}
        title="Poistetaanko maksu?"
        description={
          invoice?.payments.find((payment) => payment.id === confirmRemovePayment)?.source === "bank"
            ? "Maksu poistetaan laskulta. Tiliotteen tapahtuma jää kohdistamatta."
            : "Maksu poistetaan pysyvästi laskulta."
        }
        confirmLabel="Poista"
        onConfirm={() =>
          confirmRemovePayment ? removePayment(confirmRemovePayment) : Promise.resolve()
        }
        onCancel={() => setConfirmRemovePayment(null)}
      />

      <BottomSheet
        isOpen={closeReasonOpen}
        onClose={() => {
          setCloseReasonOpen(false);
          setCloseReasonError("");
        }}
        title="Sulje ilman täyttä maksua"
        labelledBy="close-reason-title"
      >
        <div className="space-y-3 px-5 py-4 sheet-safe-bottom">
          <Field label="Perustelu" htmlFor="close-reason">
            <input
              aria-invalid={Boolean(closeReasonError) || undefined}
              aria-describedby={closeReasonError ? "close-reason-error" : undefined}
              className={`${controlClass} min-h-12`}
              value={closeReason}
              onChange={(event) => setCloseReason(event.target.value)}
              placeholder="Esim. käteinen tai luottotappio"
              autoCapitalize="sentences"
              autoComplete="off"
              enterKeyHint="done"
            />
          </Field>
          {closeReasonError && (
            <p id="close-reason-error" className="text-caption text-danger" role="alert">
              {closeReasonError}
            </p>
          )}
          <Button type="button" className="w-full" disabled={busy} onClick={closeWithReason}>
            Sulje perustelulla
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet
        isOpen={paymentSheetOpen}
        onClose={() => {
          setPaymentSheetOpen(false);
          setPaymentError("");
        }}
        title="Kirjaa maksu"
        labelledBy="payment-sheet-title"
      >
        <div className="space-y-3 px-5 py-4 sheet-safe-bottom">
          <div className="field-dates">
            <Field label="Summa" htmlFor="payment-amount">
              <input
                aria-invalid={Boolean(paymentError) || undefined}
                aria-describedby={paymentError ? "payment-amount-error" : undefined}
                className={`${controlClass} min-h-12 tabular-nums`}
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="next"
                placeholder="125,50"
              />
            </Field>
            <Field label="Maksupäivä" htmlFor="payment-date">
              <input
                type="date"
                lang="fi"
                max={helsinkiCalendarDate()}
                className={`${controlClass} min-h-12`}
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                enterKeyHint="done"
              />
            </Field>
          </div>
          {bankRow && (
            <label className="flex min-h-12 items-start gap-3 rounded-card border border-line bg-surface px-4 py-3 text-body">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5 shrink-0 accent-accent"
                checked={useBankRow}
                onChange={(event) => {
                  setUseBankRow(event.target.checked);
                  // A different payload needs its own idempotency key.
                  paymentKey.current = newIdempotencyKey();
                }}
              />
              <span className="min-w-0">
                <span className="block text-ink">Yhdistä tiliotteen maksuun</span>
                <span className="block text-caption text-ink-2">
                  {[
                    bankRow.counterparty,
                    formatEur(bankRow.amount),
                    bankRow.date ? formatDate(bankRow.date) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {bankRow.hasReceipt
                    ? ". Tapahtumasta on jo tulokuitti; yhdistäminen estää tulon laskemisen kahdesti."
                    : ""}
                </span>
              </span>
            </label>
          )}
          {paymentError && (
            <p id="payment-amount-error" className="text-caption text-danger" role="alert">
              {paymentError}
            </p>
          )}
          <Button
            type="button"
            className="w-full"
            disabled={busy}
            disabledReason={busy ? "Tallennus on kesken." : undefined}
            onClick={() => void addPayment()}
          >
            Kirjaa maksu
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet
        isOpen={review !== null}
        onClose={() => {
          setReview(null);
          setSendError("");
        }}
        title="Lähetä lasku"
        labelledBy="send-sheet-title"
      >
        {review && (
          <div className="space-y-3 px-5 py-4 sheet-safe-bottom">
            <div className="space-y-1 text-body">
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-ink-2">Vastaanottaja</span>
                <span className="min-w-0 break-all text-right text-ink">{review.recipient ?? "–"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-2">Summa</span>
                <span className="shrink-0 whitespace-nowrap tabular-nums text-ink">
                  {formatEur(review.gross)}
                </span>
              </div>
              {review.creditNote || !review.dueDate ? null : (
                <div className="flex justify-between gap-3">
                  <span className="text-ink-2">Eräpäivä</span>
                  <span className="text-ink">{formatDate(review.dueDate)}</span>
                </div>
              )}
              {review.creditNote ? null : (
                <div className="flex justify-between gap-3">
                  <span className="shrink-0 text-ink-2">Tilinumero</span>
                  <span className="flex min-w-0 items-center justify-end gap-3 text-right text-ink">
                    <span className="min-w-0 select-text break-all">{review.iban ?? "–"}</span>
                    {review.iban ? <CopyButton text={review.iban} what="IBAN" /> : null}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-ink-2">Liite</span>
                <span className="text-ink">{review.attachment}</span>
              </div>
            </div>
            {review.blockedReason && (
              <div className="space-y-2">
                <p className="text-caption text-danger" role="alert">
                  {review.blockedReason}
                </p>
                {/* Every block names its fix (SALES-15): no dead end. */}
                {review.missing.length > 0 ? (
                  <Link href="/asetukset/laskutus" className={buttonClass("secondary", "w-full")}>
                    Avaa yritystiedot
                  </Link>
                ) : !review.recipient && invoice ? (
                  <Link
                    href={detailHref("customer", invoice.customer.id)}
                    className={buttonClass("secondary", "w-full")}
                  >
                    Lisää asiakkaalle sähköposti
                  </Link>
                ) : null}
              </div>
            )}
            {sendError && (
              <p className="text-caption text-danger" role="alert">
                {sendError}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1"
                disabled={Boolean(review.blockedReason) || busy}
                disabledReason={review.blockedReason ?? undefined}
                busy={sending}
                busyLabel="Lähetetään…"
                onClick={() => void sendByEmail()}
              >
                Lähetä
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setReview(null);
                  setSendError("");
                }}
              >
                Peruuta
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>

      {invoice && (
        <ReminderSheet
          invoiceId={invoice.id}
          customerId={invoice.customer.id}
          isOpen={reminderSheetOpen}
          preview={reminder}
          onClose={() => setReminderSheetOpen(false)}
          onSent={() => {
            setReminderSheetOpen(false);
            void load();
          }}
        />
      )}
    </>
  );
}
