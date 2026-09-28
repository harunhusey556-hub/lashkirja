"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorState, LoadingState } from "@/components/AsyncState";
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
import { shareContent } from "@/lib/share";
import { daysOverdue } from "@/lib/invoices";
import { SALES_STATUS } from "@/lib/status-labels";
import { Button, buttonClass, controlClass } from "@/components/ui";
import { Bell } from "lucide-react";
import { BottomActions, DetailHero, Icon, KeyValueList, MoreMenu, Section, StatusTag, Timeline } from "@/components/ds";

interface ReminderPreview {
  level: number;
  daysLate: number;
  open: number;
  interest: number;
  fee: number;
  total: number;
  dueDate: string;
  recipient: string | null;
  previousReminders: Array<{ level: number; sentAt: string; total: number }>;
}

interface SendPreview {
  recipient: string | null;
  gross: number;
  dueDate: string;
  iban: string | null;
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

/** One row per distinct VAT rate present on the invoice's lines. */
function vatBreakdown(lines: Invoice["lines"]): Array<{ rate: number; net: number; vat: number }> {
  const byRate = new Map<number, number>();
  for (const line of lines) {
    byRate.set(line.vatRate, (byRate.get(line.vatRate) ?? 0) + line.net);
  }
  return [...byRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, net]) => ({ rate, net, vat: (net * rate) / 100 }));
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
    const title =
      send.status === "sent"
        ? "Lähetetty sähköpostilla"
        : send.status === "failed"
          ? "Lähetys epäonnistui"
          : "Lähetys kesken";
    const metaParts = [
      formatDate(send.createdAt),
      send.toAddress,
      send.attachmentName,
      send.gross != null ? formatEur(send.gross) : null,
      send.error,
    ].filter((part): part is string => Boolean(part));
    dated.push({
      title,
      meta: metaParts.join(", "),
      tone: send.status === "failed" ? "accent" : "muted",
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

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
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
  const [remindingBusy, setRemindingBusy] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [closeReasonOpen, setCloseReasonOpen] = useState(false);
  const [closeReasonError, setCloseReasonError] = useState("");
  const [paymentSheetOpen, setPaymentSheetOpen] = useState(false);
  const [sendError, setSendError] = useState("");

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
    try {
      const response = await apiFetch(`/api/invoices/${id}`, { credentials: "include" });
      const data = await readJson<{ invoice: Invoice }>(response, "Laskun haku epäonnistui");
      setInvoice(data.invoice);
      setPaymentAmount(String(data.invoice.open > 0 ? data.invoice.open : "").replace(".", ","));
      setState("ready");

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
      setMessage(errorMessage(error, "Laskun haku epäonnistui"));
      setState("error");
    }
  }, [id, loadReminderPreview]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  async function changeStatus(status: Invoice["status"], reason?: string) {
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
    } catch (error) {
      setMessage(errorMessage(error, "Tilan vaihto epäonnistui"));
    } finally {
      setBusy(false);
    }
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
        body: JSON.stringify({ amount, paidDate: paymentDate }),
      });
      await readJson(response, "Maksun kirjaus epäonnistui");
      paymentKey.current = newIdempotencyKey();
      setPaymentAmount("");
      setPaymentSheetOpen(false);
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
    setPaymentError("");
    setPaymentAmount(String(invoice.open > 0 ? invoice.open : "").replace(".", ","));
    setPaymentSheetOpen(true);
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
      const file = new File([blob], `lasku-${invoice.number}.pdf`, {
        type: blob.type || "application/pdf",
      });
      const result = await shareContent({
        title: `Lasku ${invoice.number}`,
        text: `Lasku ${invoice.number}`,
        url: window.location.href,
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
      const result = await readJson<{ invoice: { id: string } }>(response, "Hyvitys epäonnistui");
      router.push(`/laskut/${result.invoice.id}`);
    } catch (error) {
      setMessage(errorMessage(error, "Hyvitys epäonnistui"));
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
      const result = await readJson<{ invoice: { id: string } }>(response, "Kopiointi epäonnistui");
      router.push(`/laskut/${result.invoice.id}`);
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

  async function sendReminder() {
    setRemindingBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/reminders`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await readJson<{ sentTo: string; reminder: { level: number } }>(
        response,
        "Muistutuksen lähetys epäonnistui"
      );
      setMessage(
        `Maksumuistutus ${result.reminder.level} lähetettiin osoitteeseen ${result.sentTo}.`
      );
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Muistutuksen lähetys epäonnistui"));
    } finally {
      setRemindingBusy(false);
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
        busy: loading || remindingBusy,
        busyLabel: loading ? "Ladataan…" : "Lähetetään…",
        icon: true,
      };
    }
    if (invoice.status === "sent") {
      return { kind: "pay", label: "Kirjaa maksu", busy: false };
    }
    return null;
  })();

  const menuItems = invoice
    ? [
        {
          label: "Avaa PDF",
          onSelect: () => window.open(`/api/invoices/${invoice.id}/pdf`, "_blank", "noopener,noreferrer"),
        },
        { label: "Jaa", onSelect: () => void shareInvoice(), disabled: busy || sharing },
        ...(invoice.status !== "credited"
          ? [{ label: "Lähetä sähköpostilla", onSelect: () => void openReview(), disabled: busy || sending }]
          : []),
        { label: "Kopioi luonnokseksi", onSelect: () => void duplicateInvoice(), disabled: busy },
        ...(invoice.documentKind !== "credit_note" &&
        invoice.status !== "credited" &&
        invoice.status !== "draft"
          ? [{ label: "Hyvitä", onSelect: () => void createCreditNote(), disabled: busy }]
          : []),
        ...(invoice.status === "draft"
          ? [{ label: "Merkitse lähetetyksi", onSelect: () => void changeStatus("sent"), disabled: busy }]
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
      <div className="space-y-6 pb-6">
        {state === "loading" && <LoadingState label="Haetaan laskua…" />}
        {state === "error" && (
          <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
        )}

        {state === "ready" && invoice && (
          <>
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
                    <Link href={`/asiakkaat/${invoice.customer.id}`} className="text-accent">
                      Asiakas
                    </Link>
                    {invoice.customer.businessId ? ` · ${invoice.customer.businessId}` : ""}
                  </span>
                </>
              }
              status={
                <StatusTag tone={SALES_STATUS[invoice.displayStatus].tone}>
                  {invoice.displayStatus === "overdue"
                    ? `Myöhässä ${daysOverdue(invoice.dueDate)} päivää`
                    : SALES_STATUS[invoice.displayStatus].label}
                </StatusTag>
              }
              menu={<MoreMenu items={menuItems} />}
            />

            {message && (
              <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
                {message}
              </p>
            )}

            <KeyValueList
              rows={[
                { label: "Päivätty", value: formatDate(invoice.issueDate) },
                { label: "Eräpäivä", value: formatDate(invoice.dueDate) },
                { label: "Viite", value: formatReference(invoice.reference) },
                {
                  label: "Rivit",
                  value:
                    invoice.lines.length > 0
                      ? `${invoice.lines[0].description}, ${invoice.lines.length} kpl`
                      : "Ei rivejä",
                },
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

            {(invoice.payments.length > 0 ||
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
                  <p className="px-4 py-4 text-[15px] text-ink-2">Ei maksuja vielä.</p>
                ) : (
                  invoice.payments.map((payment) => (
                    <div key={payment.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div>
                        <p className="text-[15px] text-ink">{formatEur(payment.amount)}</p>
                        <p className="text-[13px] text-ink-2">
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

            {reminder && (
              <Section title="Muistutukset">
                <div className="space-y-3 px-4 py-4">
                  <p className="text-[13px] text-ink-2">
                    Myöhässä {reminder.daysLate} päivää · muistutus {reminder.level}
                  </p>
                  <div className="space-y-1 text-[15px]">
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
                  <a
                    href={`/api/invoices/${invoice.id}/reminders/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClass("secondary")}
                  >
                    Avaa muistutus
                  </a>
                  {reminder.previousReminders.length > 0 && (
                    <ul className="space-y-1 text-[13px] text-ink-2">
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
              <h2 className="mb-2 px-1 text-[13px] font-normal text-ink-2">Historia</h2>
              <Timeline items={historyItems(invoice)} />
            </section>

            {invoice.notes && (
              <Section title="Viesti laskulla">
                <p className="whitespace-pre-wrap px-4 py-4 text-[15px] text-ink">{invoice.notes}</p>
              </Section>
            )}
          </>
        )}
      </div>

      {state === "ready" && invoice && primary && (
        <BottomActions>
          <Button
            type="button"
            className="w-full"
            busy={primary.busy}
            busyLabel={primary.busyLabel}
            disabled={busy}
            onClick={
              primary.kind === "send"
                ? () => void openReview()
                : primary.kind === "remind"
                  ? () => void sendReminder()
                  : primary.kind === "retryReminder"
                    ? () => void retryReminderPreview()
                    : primary.kind === "markPaid"
                      ? () => void changeStatus("paid")
                      : () => openPaymentSheet()
            }
          >
            {primary.icon ? <Icon icon={Bell} size="inline" /> : null}
            {primary.label}
          </Button>
          {invoice.displayStatus === "overdue" && invoice.open > 0 && (
            <button
              type="button"
              className="active-press flex min-h-12 w-full items-center justify-center text-[15px] font-semibold text-accent"
              onClick={() => openPaymentSheet()}
            >
              Kirjaa maksu
            </button>
          )}
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
        isOpen={confirmRemovePayment !== null}
        title="Poistetaanko maksu?"
        description="Maksu poistetaan pysyvästi laskulta."
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
          <input
            aria-label="Sulkemisen perustelu"
            aria-invalid={Boolean(closeReasonError) || undefined}
            aria-describedby={closeReasonError ? "close-reason-error" : undefined}
            className={`${controlClass} min-h-12`}
            value={closeReason}
            onChange={(event) => setCloseReason(event.target.value)}
            placeholder="Perustelu, esim. käteinen tai luottotappio"
          />
          {closeReasonError && (
            <p id="close-reason-error" className="text-sm text-danger" role="alert">
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
            <input
              id="payment-amount"
              aria-label="Maksun summa"
              aria-invalid={Boolean(paymentError) || undefined}
              aria-describedby={paymentError ? "payment-amount-error" : undefined}
              className={`${controlClass} min-h-12`}
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              inputMode="decimal"
              placeholder="125,50"
            />
            <input
              aria-label="Maksun päivä"
              type="date"
              className={`${controlClass} min-h-12`}
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </div>
          {paymentError && (
            <p id="payment-amount-error" className="text-sm text-danger" role="alert">
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
            Lisää
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
            <div className="space-y-1 text-[15px]">
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
              <div className="flex justify-between gap-3">
                <span className="text-ink-2">Eräpäivä</span>
                <span className="text-ink">{formatDate(review.dueDate)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="shrink-0 text-ink-2">Tilinumero</span>
                <span className="min-w-0 break-all text-right text-ink">{review.iban ?? "–"}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-ink-2">Liite</span>
                <span className="text-ink">{review.attachment}</span>
              </div>
            </div>
            {review.blockedReason && (
              <p className="text-sm text-danger" role="alert">
                {review.blockedReason}
              </p>
            )}
            {sendError && (
              <p className="text-sm text-danger" role="alert">
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
    </>
  );
}
