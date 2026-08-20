"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
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
import { VAT_RATES_PERMILLE } from "@/lib/invoices";
import { RECURRENCE_INTERVALS, type RecurrenceInterval } from "@/lib/recurrence";

interface RecurringInvoice {
  id: string;
  name: string | null;
  interval: RecurrenceInterval;
  anchorDay: number;
  startDate: string;
  endDate: string | null;
  nextRunAt: string | null;
  paymentTermDays: number;
  autoSend: boolean;
  active: boolean;
  customer: { id: string; name: string; email: string | null };
  lines: Array<{ id: string; description: string; quantity: number; unit: string; unitPrice: number; vatRate: number }>;
  total: number;
  generatedCount: number;
  lastRun: { issueDate: string; status: string; invoiceId: string | null } | null;
}

interface FormLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: number;
}

const INTERVAL_LABEL: Record<RecurrenceInterval, string> = {
  monthly: "Kuukausittain",
  quarterly: "Neljännesvuosittain",
  yearly: "Vuosittain",
};

const EMPTY_LINE: FormLine = {
  description: "",
  quantity: "1",
  unit: "kpl",
  unitPrice: "",
  vatRate: 25.5,
};

const today = () => new Date().toISOString().slice(0, 10);

export default function RecurringInvoicesPage() {
  const [recurring, setRecurring] = useState<RecurringInvoice[]>([]);
  const [dueNow, setDueNow] = useState(0);
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<RecurringInvoice | null>(null);

  const [form, setForm] = useState({
    customerId: "",
    name: "",
    interval: "monthly" as RecurrenceInterval,
    anchorDay: "1",
    startDate: today(),
    endDate: "",
    paymentTermDays: "14",
    autoSend: false,
    lines: [{ ...EMPTY_LINE }] as FormLine[],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(
        `/api/recurring-invoices${showInactive ? "?includeInactive=1" : ""}`,
        { credentials: "include" }
      );
      const data = await readJson<{ recurring: RecurringInvoice[]; dueNow: number }>(
        response,
        "Toistuvien laskujen haku epäonnistui"
      );
      setRecurring(data.recurring);
      setDueNow(data.dueNow);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setMessage(errorMessage(error, "Toistuvien laskujen haku epäonnistui"));
      setStatus("error");
    }
  }, [showInactive]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  useEffect(() => {
    apiFetch("/api/customers", { credentials: "include" })
      .then((response) => readJson<{ customers: Array<{ id: string; name: string }> }>(response, ""))
      .then((data) => setCustomers(data.customers ?? []))
      .catch(() => {});
  }, []);

  function setLine(index: number, patch: Partial<FormLine>) {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!form.customerId) nextErrors.customerId = "Valitse asiakas.";
    const anchorDay = Number(form.anchorDay);
    if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
      nextErrors.anchorDay = "Laskutuspäivä on 1-31.";
    }
    if (form.endDate && form.endDate < form.startDate) {
      nextErrors.endDate = "Päättymispäivä ei voi olla ennen alkupäivää.";
    }

    const lines = form.lines
      .map((line) => {
        const quantity = parseFinnishNumber(line.quantity);
        const unitPrice = parseFinnishNumber(line.unitPrice);
        if (!line.description.trim() || quantity === null || unitPrice === null) return null;
        return {
          description: line.description.trim(),
          quantity,
          unit: line.unit.trim() || "kpl",
          unitPrice,
          vatRate: line.vatRate,
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);
    if (lines.length === 0) nextErrors.lines = "Lisää vähintään yksi rivi.";

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setBusy(true);
    setMessage(null);

    try {
      const response = await apiFetch("/api/recurring-invoices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: form.customerId,
          name: form.name.trim() || null,
          interval: form.interval,
          anchorDay,
          startDate: form.startDate,
          endDate: form.endDate || null,
          paymentTermDays: Number(form.paymentTermDays) || 14,
          autoSend: form.autoSend,
          lines,
        }),
      });
      await readJson(response, "Tallennus epäonnistui");
      setCreating(false);
      setForm({ ...form, name: "", lines: [{ ...EMPTY_LINE }] });
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function runDue(recurringInvoiceId?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/recurring-invoices/run", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recurringInvoiceId ? { recurringInvoiceId } : {}),
      });
      const result = await readJson<{
        generated: Array<{ invoiceNumber: number; sent: boolean; sendError: string | null }>;
        skipped: Array<{ reason: string }>;
      }>(response, "Laskujen luonti epäonnistui");

      const failedSends = result.generated.filter((entry) => entry.sendError).length;
      setMessage(
        `Luotiin ${result.generated.length} laskua.` +
          (result.skipped.length ? ` ${result.skipped.length} ohitettiin.` : "") +
          (failedSends ? ` ${failedSends} laskun lähetys epäonnistui — lasku on silti tallessa.` : "")
      );
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Laskujen luonti epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(entry: RecurringInvoice) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/recurring-invoices/${entry.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !entry.active }),
      });
      await readJson(response, "Muutos epäonnistui");
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Muutos epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: RecurringInvoice) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/recurring-invoices/${entry.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await readJson(response, "Poisto epäonnistui");
      setMessage("Toistuva lasku poistettiin. Jo luodut laskut säilyvät.");
      setConfirmRemove(null);
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Poisto epäonnistui"));
      setConfirmRemove(null);
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full px-3 py-2.5 rounded-xl border border-warm-gray-light/60 bg-white text-sm";
  const label = "text-sm font-medium text-charcoal";

  return (
    <AppShell>
      <div className="space-y-6 pb-6">
        <header className="space-y-2">
          <h2 className="text-2xl font-semibold text-charcoal tracking-tight">Toistuvat laskut</h2>
          <p className="text-sm text-warm-gray leading-relaxed">
            Sama lasku samalle asiakkaalle aikataulun mukaan. Rivit ovat pohja: jo luotu lasku ei
            muutu, vaikka pohjaa muokkaisi.
          </p>
        </header>

        {dueNow > 0 && (
          <section className="bg-white rounded-3xl border border-accent/30 shadow-sm p-6 space-y-3">
            <p className="text-sm text-charcoal">
              {dueNow} toistuvaa laskua on erääntynyt luotavaksi.
            </p>
            <button
              type="button"
              onClick={() => void runDue()}
              disabled={busy}
              className="w-full py-3 rounded-2xl bg-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Luodaan…" : "Luo erääntyneet laskut"}
            </button>
          </section>
        )}

        {message && (
          <p className="text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3" role="status">
            {message}
          </p>
        )}

        {creating ? (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
            <p className="text-base font-medium text-charcoal">Uusi toistuva lasku</p>
            {customers.length === 0 ? (
              <p className="text-sm text-warm-gray">
                Lisää ensin asiakas <Link className="text-accent" href="/asiakkaat">Asiakkaat</Link>-sivulla.
              </p>
            ) : (
              <form onSubmit={submit} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <label className={label} htmlFor="ri-customer">Asiakas</label>
                  <select
                    id="ri-customer"
                    className={field}
                    value={form.customerId}
                    onChange={(e) => setForm({ ...form, customerId: e.target.value })}
                  >
                    <option value="">Valitse asiakas</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>
                  {errors.customerId && <p className="text-xs text-danger">{errors.customerId}</p>}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={label} htmlFor="ri-interval">Toistoväli</label>
                    <select
                      id="ri-interval"
                      className={field}
                      value={form.interval}
                      onChange={(e) =>
                        setForm({ ...form, interval: e.target.value as RecurrenceInterval })
                      }
                    >
                      {RECURRENCE_INTERVALS.map((interval) => (
                        <option key={interval} value={interval}>
                          {INTERVAL_LABEL[interval]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className={label} htmlFor="ri-anchor">Laskutuspäivä</label>
                    <input
                      id="ri-anchor"
                      className={field}
                      value={form.anchorDay}
                      onChange={(e) => setForm({ ...form, anchorDay: e.target.value })}
                      inputMode="numeric"
                    />
                    {errors.anchorDay ? (
                      <p className="text-xs text-danger">{errors.anchorDay}</p>
                    ) : (
                      <p className="text-xs text-warm-gray">
                        31 tarkoittaa kuun viimeistä päivää lyhyissä kuukausissa.
                      </p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className={label} htmlFor="ri-start">Alkaa</label>
                    <input
                      id="ri-start"
                      type="date"
                      className={field}
                      value={form.startDate}
                      onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className={label} htmlFor="ri-end">Päättyy (valinnainen)</label>
                    <input
                      id="ri-end"
                      type="date"
                      className={field}
                      value={form.endDate}
                      onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    />
                    {errors.endDate && <p className="text-xs text-danger">{errors.endDate}</p>}
                  </div>
                </div>

                <div className="space-y-3">
                  <p className={label}>Rivit</p>
                  {form.lines.map((line, index) => (
                    <div
                      key={index}
                      className="rounded-2xl border border-warm-gray-light/40 p-3 space-y-2 bg-cream/40"
                    >
                      <input
                        aria-label={`Rivin ${index + 1} kuvaus`}
                        className={field}
                        value={line.description}
                        onChange={(e) => setLine(index, { description: e.target.value })}
                        placeholder="Kuukausiylläpito"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          aria-label={`Rivin ${index + 1} määrä`}
                          className={field}
                          value={line.quantity}
                          onChange={(e) => setLine(index, { quantity: e.target.value })}
                          inputMode="decimal"
                        />
                        <input
                          aria-label={`Rivin ${index + 1} yksikkö`}
                          className={field}
                          value={line.unit}
                          onChange={(e) => setLine(index, { unit: e.target.value })}
                        />
                        <input
                          aria-label={`Rivin ${index + 1} hinta`}
                          className={field}
                          value={line.unitPrice}
                          onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                          inputMode="decimal"
                          placeholder="€"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={`Rivin ${index + 1} ALV`}
                          className={`${field} flex-1`}
                          value={line.vatRate}
                          onChange={(e) => setLine(index, { vatRate: Number(e.target.value) })}
                        >
                          {VAT_RATES_PERMILLE.map((permille) => (
                            <option key={permille} value={permille / 10}>
                              ALV {permille / 10} %
                            </option>
                          ))}
                        </select>
                        {form.lines.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setForm({
                                ...form,
                                lines: form.lines.filter((_, i) => i !== index),
                              })
                            }
                            className="px-3 py-2 rounded-xl border border-danger/40 text-danger text-xs"
                          >
                            Poista
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, lines: [...form.lines, { ...EMPTY_LINE }] })}
                    className="w-full py-2.5 rounded-2xl border border-warm-gray-light/60 text-sm font-medium"
                  >
                    Lisää rivi
                  </button>
                  {errors.lines && <p className="text-xs text-danger">{errors.lines}</p>}
                </div>

                <label className="flex items-center gap-3 text-sm text-charcoal">
                  <input
                    type="checkbox"
                    checked={form.autoSend}
                    onChange={(e) => setForm({ ...form, autoSend: e.target.checked })}
                    className="w-4 h-4"
                  />
                  Lähetä lasku asiakkaalle sähköpostilla heti kun se luodaan
                </label>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="flex-1 py-3 rounded-2xl border border-warm-gray-light/60 text-sm font-medium"
                  >
                    Peruuta
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="flex-1 py-3 rounded-2xl bg-accent text-white text-sm font-medium disabled:opacity-50"
                  >
                    {busy ? "Tallennetaan…" : "Luo toistuva lasku"}
                  </button>
                </div>
              </form>
            )}
          </section>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="w-full py-3.5 rounded-2xl bg-accent text-white text-sm font-medium hover:bg-accent-dark"
          >
            Uusi toistuva lasku
          </button>
        )}

        {status === "loading" && <LoadingState label="Haetaan toistuvia laskuja…" />}
        {status === "error" && (
          <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
        )}

        {status === "ready" && (
          <ul className="space-y-3">
            {recurring.map((entry) => (
              <li
                key={entry.id}
                className={`bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-5 space-y-3 ${
                  entry.active ? "" : "opacity-60"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-charcoal truncate">
                      {entry.name || entry.customer.name}
                    </p>
                    <p className="text-xs text-warm-gray truncate">
                      {entry.customer.name} · {INTERVAL_LABEL[entry.interval]} ·{" "}
                      {entry.anchorDay}. päivä
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-base font-semibold text-charcoal">
                      {formatEur(entry.total)}
                    </p>
                    <p className="text-[11px] text-warm-gray">veroton</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {entry.nextRunAt ? (
                    <span className="px-2 py-0.5 rounded-full bg-blush text-accent-dark">
                      Seuraava {formatDate(entry.nextRunAt)}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-warm-gray-light/30 text-warm-gray">
                      Päättynyt
                    </span>
                  )}
                  {entry.autoSend && (
                    <span className="px-2 py-0.5 rounded-full bg-success/10 text-success">
                      Lähetetään automaattisesti
                    </span>
                  )}
                  {!entry.active && (
                    <span className="px-2 py-0.5 rounded-full bg-warm-gray-light/30 text-warm-gray">
                      Pysäytetty
                    </span>
                  )}
                  <span className="px-2 py-0.5 rounded-full bg-warm-gray-light/25 text-warm-gray">
                    {entry.generatedCount} laskua luotu
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {entry.active && entry.nextRunAt && (
                    <button
                      type="button"
                      onClick={() => void runDue(entry.id)}
                      disabled={busy}
                      className="text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60 disabled:opacity-50"
                    >
                      Luo nyt
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void toggleActive(entry)}
                    disabled={busy}
                    className="text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60 disabled:opacity-50"
                  >
                    {entry.active ? "Pysäytä" : "Jatka"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(entry)}
                    className="text-xs font-medium px-3 py-2 rounded-xl border border-danger/40 text-danger"
                  >
                    Poista
                  </button>
                </div>
              </li>
            ))}

            {recurring.length === 0 && (
              <p className="text-sm text-warm-gray text-center py-8">
                Ei toistuvia laskuja.
              </p>
            )}
          </ul>
        )}

        <button
          type="button"
          onClick={() => setShowInactive((value) => !value)}
          className="w-full text-xs text-warm-gray py-2"
        >
          {showInactive ? "Piilota pysäytetyt" : "Näytä pysäytetyt"}
        </button>
      </div>

      <ConfirmModal
        isOpen={confirmRemove !== null}
        title="Poistetaanko toistuva lasku?"
        description={
          confirmRemove
            ? `${confirmRemove.name || confirmRemove.customer.name} — jo luodut laskut säilyvät.`
            : ""
        }
        confirmLabel="Poista"
        onConfirm={() => confirmRemove && void remove(confirmRemove)}
        onCancel={() => setConfirmRemove(null)}
      />
    </AppShell>
  );
}
