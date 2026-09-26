"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import ConfirmModal from "@/components/ConfirmModal";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDate, formatEur, parseFinnishNumber } from "@/lib/format";
import { formatReference } from "@/lib/finnish-reference";
import { shareContent } from "@/lib/share";
import { Button } from "@/components/ui";

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

interface Invoice {
  id: string;
  number: number;
  reference: string;
  status: "draft" | "sent" | "paid" | "credited";
  displayStatus: "draft" | "sent" | "paid" | "credited" | "overdue";
  issueDate: string;
  dueDate: string;
  notes: string | null;
  net: number;
  vat: number;
  gross: number;
  paid: number;
  open: number;
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
}

const STATUS_LABEL: Record<Invoice["displayStatus"], string> = {
  draft: "Luonnos",
  sent: "Lähetetty",
  overdue: "Myöhässä",
  paid: "Maksettu",
  credited: "Hyvitetty",
};

export default function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemovePayment, setConfirmRemovePayment] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [reminder, setReminder] = useState<ReminderPreview | null>(null);
  const [remindingBusy, setRemindingBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/invoices/${id}`, { credentials: "include" });
      const data = await readJson<{ invoice: Invoice }>(response, "Laskun haku epäonnistui");
      setInvoice(data.invoice);
      setPaymentAmount(String(data.invoice.open > 0 ? data.invoice.open : "").replace(".", ","));
      setState("ready");

      // The reminder preview only exists for an invoice that is genuinely
      // overdue; a 409 here is the expected answer, not an error to show.
      if (data.invoice.displayStatus === "overdue") {
        try {
          const preview = await apiFetch(`/api/invoices/${id}/reminders`, {
            credentials: "include",
          });
          const previewData = await readJson<{ reminder: ReminderPreview }>(preview, "");
          setReminder(previewData.reminder);
        } catch {
          setReminder(null);
        }
      } else {
        setReminder(null);
      }
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setMessage(errorMessage(error, "Laskun haku epäonnistui"));
      setState("error");
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  async function changeStatus(status: Invoice["status"]) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/status`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await readJson(response, "Tilan vaihto epäonnistui");
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Tilan vaihto epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function addPayment() {
    const amount = parseFinnishNumber(paymentAmount);
    if (amount === null || amount === 0) {
      setMessage("Anna maksun summa, esim. 125,50.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/invoices/${id}/payments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, paidDate: paymentDate }),
      });
      await readJson(response, "Maksun kirjaus epäonnistui");
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Maksun kirjaus epäonnistui"));
    } finally {
      setBusy(false);
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
      setMessage(errorMessage(error, "Maksun poisto epäonnistui"));
    } finally {
      setBusy(false);
      setConfirmRemovePayment(null);
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
      const result = await readJson<{ sentTo: string }>(response, "Lähetys epäonnistui");
      setMessage(`Lasku lähetettiin osoitteeseen ${result.sentTo}.`);
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Lähetys epäonnistui"));
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
      setMessage(errorMessage(error, "Poisto epäonnistui"));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="space-y-6 pb-6">
        {state === "loading" && <LoadingState label="Haetaan laskua…" />}
        {state === "error" && (
          <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
        )}

        {state === "ready" && invoice && (
          <>
            <header className="space-y-2">
              <h2 className="text-2xl font-semibold text-charcoal tracking-tight">
                Lasku {invoice.number}
              </h2>
              <p className="text-sm text-warm-gray">
                {invoice.customer.name}
                {invoice.customer.businessId ? ` · ${invoice.customer.businessId}` : ""}
              </p>
            </header>

            {message && (
              <p className="text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3" role="status">
                {message}
              </p>
            )}

            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-warm-gray">Tila</span>
                <span className="text-sm font-medium text-charcoal">
                  {STATUS_LABEL[invoice.displayStatus]}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-warm-gray">Laskun päivä</span>
                <span className="text-sm text-charcoal">{formatDate(invoice.issueDate)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-warm-gray">Eräpäivä</span>
                <span className="text-sm text-charcoal">{formatDate(invoice.dueDate)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-warm-gray">Viitenumero</span>
                <span className="text-sm font-mono text-charcoal">
                  {formatReference(invoice.reference)}
                </span>
              </div>
            </section>

            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
              <p className="text-base font-medium text-charcoal">Rivit</p>
              <ul className="space-y-2">
                {invoice.lines.map((line) => (
                  <li key={line.id} className="flex justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="text-charcoal truncate">{line.description}</p>
                      <p className="text-xs text-warm-gray">
                        {line.quantity} {line.unit} × {formatEur(line.unitPrice)} · ALV {line.vatRate} %
                      </p>
                    </div>
                    <span className="text-charcoal shrink-0">{formatEur(line.net)}</span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-warm-gray-light/30 pt-3 space-y-1 text-sm">
                <div className="flex justify-between text-warm-gray">
                  <span>Veroton</span>
                  <span>{formatEur(invoice.net)}</span>
                </div>
                <div className="flex justify-between text-warm-gray">
                  <span>ALV</span>
                  <span>{formatEur(invoice.vat)}</span>
                </div>
                <div className="flex justify-between font-semibold text-charcoal">
                  <span>Yhteensä</span>
                  <span>{formatEur(invoice.gross)}</span>
                </div>
                {invoice.paid !== 0 && (
                  <div className="flex justify-between text-success">
                    <span>Maksettu</span>
                    <span>{formatEur(invoice.paid)}</span>
                  </div>
                )}
                {invoice.open !== 0 && (
                  <div className="flex justify-between font-medium text-charcoal">
                    <span>Avoinna</span>
                    <span>{formatEur(invoice.open)}</span>
                  </div>
                )}
              </div>
              {invoice.notes && (
                <p className="text-sm text-warm-gray border-t border-warm-gray-light/30 pt-3">
                  {invoice.notes}
                </p>
              )}
            </section>

            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
              <p className="text-base font-medium text-charcoal">Toiminnot</p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`/api/invoices/${invoice.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="active-press inline-flex min-h-12 items-center px-4 rounded-xl border border-warm-gray-light/60 text-sm font-medium text-charcoal"
                >
                  Avaa PDF
                </a>
                <Button
                  variant="secondary"
                  busy={sharing}
                  busyLabel="Jaetaan…"
                  disabled={busy}
                  onClick={() => void shareInvoice()}
                >
                  Jaa
                </Button>
                {invoice.status !== "credited" && (
                  <Button
                    variant="secondary"
                    busy={sending}
                    busyLabel="Lähetetään…"
                    disabled={busy}
                    onClick={() => void sendByEmail()}
                  >
                    Lähetä sähköpostilla
                  </Button>
                )}
                {invoice.status === "draft" && (
                  <Button disabled={busy} onClick={() => void changeStatus("sent")}>
                    Merkitse lähetetyksi
                  </Button>
                )}
                {invoice.status === "sent" && (
                  <Button disabled={busy} onClick={() => void changeStatus("paid")}>
                    Merkitse maksetuksi
                  </Button>
                )}
                {invoice.status !== "credited" && invoice.status !== "draft" && (
                  <Button variant="secondary" disabled={busy} onClick={() => void changeStatus("credited")}>
                    Hyvitä
                  </Button>
                )}
                {invoice.status === "draft" && (
                  <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    Poista luonnos
                  </Button>
                )}
              </div>

              {(invoice.status === "sent" || invoice.status === "paid") && (
                <div className="space-y-2 border-t border-warm-gray-light/30 pt-4">
                  <p className="text-sm font-medium text-charcoal">Kirjaa maksu</p>
                  <div className="flex gap-2">
                    <input
                      aria-label="Maksun summa"
                      className="flex-1 px-3 py-2.5 rounded-xl border border-warm-gray-light/60 text-sm"
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(e.target.value)}
                      inputMode="decimal"
                      placeholder="125,50"
                    />
                    <input
                      aria-label="Maksun päivä"
                      type="date"
                      className="px-3 py-2.5 rounded-xl border border-warm-gray-light/60 text-sm"
                      value={paymentDate}
                      onChange={(e) => setPaymentDate(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => void addPayment()}
                      disabled={busy}
                      className="min-h-11 px-4 py-2.5 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-50"
                    >
                      Lisää
                    </button>
                  </div>
                </div>
              )}

              {reminder && (
                <div className="space-y-3 border-t border-warm-gray-light/30 pt-4">
                  <div>
                    <p className="text-sm font-medium text-charcoal">Maksumuistutus</p>
                    <p className="text-xs text-warm-gray">
                      Myöhässä {reminder.daysLate} päivää · muistutus {reminder.level}
                    </p>
                  </div>

                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between text-warm-gray">
                      <span>Avoin pääoma</span>
                      <span>{formatEur(reminder.open)}</span>
                    </div>
                    {reminder.interest > 0 && (
                      <div className="flex justify-between text-warm-gray">
                        <span>Viivästyskorko</span>
                        <span>{formatEur(reminder.interest)}</span>
                      </div>
                    )}
                    {reminder.fee > 0 && (
                      <div className="flex justify-between text-warm-gray">
                        <span>Muistutusmaksu</span>
                        <span>{formatEur(reminder.fee)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-semibold text-charcoal">
                      <span>Maksettava yhteensä</span>
                      <span>{formatEur(reminder.total)}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <a
                      href={`/api/invoices/${invoice.id}/reminders/pdf`}
                      target="_blank"
                      rel="noreferrer"
                      className="min-h-11 px-4 py-2.5 rounded-xl border border-warm-gray-light/60 text-sm font-medium text-charcoal"
                    >
                      Avaa muistutus
                    </a>
                    <button
                      type="button"
                      onClick={() => void sendReminder()}
                      disabled={remindingBusy || busy}
                      className="min-h-11 px-4 py-2.5 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-50"
                    >
                      {remindingBusy ? "Lähetetään…" : "Lähetä maksumuistutus"}
                    </button>
                  </div>

                  {reminder.previousReminders.length > 0 && (
                    <ul className="space-y-1 text-xs text-warm-gray">
                      {reminder.previousReminders.map((previous) => (
                        <li key={`${previous.level}-${previous.sentAt}`}>
                          Muistutus {previous.level} · {formatDate(previous.sentAt.slice(0, 10))} ·{" "}
                          {formatEur(previous.total)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {invoice.payments.length > 0 && (
                <ul className="space-y-2 border-t border-warm-gray-light/30 pt-4">
                  {invoice.payments.map((payment) => (
                    <li key={payment.id} className="flex items-center justify-between gap-3 text-sm">
                      <div>
                        <p className="text-charcoal">{formatEur(payment.amount)}</p>
                        <p className="text-xs text-warm-gray">
                          {formatDate(payment.paidDate)}
                          {payment.source === "bank" ? " · pankista" : ""}
                          {payment.note ? ` · ${payment.note}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setConfirmRemovePayment(payment.id)}
                        disabled={busy}
                        className="min-h-11 inline-flex items-center px-3 py-2 rounded-xl text-danger disabled:opacity-50"
                      >
                        Poista
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmDelete}
        title="Poistetaanko luonnos?"
        description="Luonnos poistetaan pysyvästi."
        confirmLabel="Poista"
        onConfirm={() => void deleteInvoice()}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmModal
        isOpen={confirmRemovePayment !== null}
        title="Poistetaanko maksu?"
        description="Maksu poistetaan pysyvästi laskulta."
        confirmLabel="Poista"
        onConfirm={() => {
          if (confirmRemovePayment) void removePayment(confirmRemovePayment);
        }}
        onCancel={() => setConfirmRemovePayment(null)}
      />
    </>
  );
}
