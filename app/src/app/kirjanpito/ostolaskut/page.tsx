"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingState } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDate, formatEur, parseFinnishNumber } from "@/lib/format";
import { isValidReferenceNumber, normalizeReference } from "@/lib/finnish-reference";

import { Button, chipClass, controlClass } from "@/components/ui";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { isForbidden } from "@/lib/screen-state";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
interface PurchaseInvoice {
  id: string;
  supplierName: string;
  invoiceNumber: string | null;
  reference: string | null;
  issueDate: string;
  dueDate: string;
  status: "open" | "paid" | "cancelled";
  displayStatus: "open" | "paid" | "cancelled" | "overdue";
  gross: number;
  vat: number;
  net: number;
  paid: number;
  open: number;
  category: string | null;
  notes: string | null;
  payments: Array<{ id: string; paidDate: string; amount: number; source: string }>;
}

interface Aging {
  buckets: Record<string, { count: number; openCents: number }>;
  totalOpen: number;
  overdue: number;
  overdueCount: number;
}

const STATUS_LABEL: Record<PurchaseInvoice["displayStatus"], string> = {
  open: "Avoin",
  overdue: "Myöhässä",
  paid: "Maksettu",
  cancelled: "Mitätöity",
};

const STATUS_CLASS: Record<PurchaseInvoice["displayStatus"], string> = {
  open: "bg-blush text-accent-dark",
  overdue: "bg-danger/10 text-danger",
  paid: "bg-success/10 text-success",
  cancelled: "bg-warm-gray-light/30 text-warm-gray",
};

const FILTERS = [
  { id: "all", label: "Kaikki" },
  { id: "open", label: "Avoimet" },
  { id: "overdue", label: "Myöhässä" },
  { id: "paid", label: "Maksetut" },
] as const;

const today = () => new Date().toISOString().slice(0, 10);

export default function PurchaseInvoicesPage() {
  const cached = readPageCache<{ invoices: PurchaseInvoice[]; aging: Aging }>("purchases");
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>(cached?.invoices ?? []);
  const [aging, setAging] = useState<Aging | null>(cached?.aging ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  // Persisted so back-navigation restores the active tab instead of resetting
  // the list to "Avoimet".
  const [filter, setFilter] = usePersistedState<(typeof FILTERS)[number]["id"]>(
    "ostolaskut.filter",
    "open"
  );
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PurchaseInvoice | null>(null);

  const [form, setForm] = useState({
    supplierName: "",
    invoiceNumber: "",
    reference: "",
    issueDate: today(),
    dueDate: today(),
    gross: "",
    vat: "",
    category: "",
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, string>>({});

  // `signal` is only ever passed by the mount/filter-change effect below —
  // manual call sites (retry button, post-mutation refresh) call load() with
  // no signal so they are never cancelled out from under themselves.
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      const response = await apiFetch(`/api/purchase-invoices?${params.toString()}`, {
        credentials: "include",
        signal,
      });
      const data = await readJson<{ invoices: PurchaseInvoice[]; aging: Aging }>(
        response,
        "Ostolaskujen haku epäonnistui"
      );
      if (signal?.aborted) return;
      writePageCache("purchases", data);
      setInvoices(data.invoices);
      setAging(data.aging);
      setLoadFailure(null);
      setStatus("ready");
    } catch (error) {
      if (signal?.aborted) return;
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setMessage(errorMessage(error, "Ostolaskujen haku epäonnistui"));
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useScrollRestoration("ostolaskut", status === "ready");

  function validate() {
    const errors: Record<string, string> = {};
    if (!form.supplierName.trim()) errors.supplierName = "Anna toimittajan nimi.";
    const gross = parseFinnishNumber(form.gross);
    if (gross === null || gross <= 0) errors.gross = "Anna laskun summa, esim. 124,00.";
    const vat = form.vat.trim() ? parseFinnishNumber(form.vat) : 0;
    if (vat === null || vat < 0) errors.vat = "ALV on virheellinen.";
    if (gross !== null && vat !== null && vat > gross) errors.vat = "ALV ei voi ylittää summaa.";
    if (form.dueDate < form.issueDate) errors.dueDate = "Eräpäivä ei voi olla ennen laskun päivää.";
    if (form.reference.trim() && !isValidReferenceNumber(form.reference)) {
      errors.reference = "Viitenumero ei täsmää.";
    }
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return null;
    }
    setFormErrors({});
    return {
      supplierName: form.supplierName.trim(),
      invoiceNumber: form.invoiceNumber.trim() || null,
      reference: form.reference.trim() ? normalizeReference(form.reference) : null,
      issueDate: form.issueDate,
      dueDate: form.dueDate,
      gross: gross as number,
      vat: vat as number,
      category: form.category.trim() || null,
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const payload = validate();
    if (!payload) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/purchase-invoices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await readJson(response, "Tallennus epäonnistui");
      setCreating(false);
      setForm({
        supplierName: "",
        invoiceNumber: "",
        reference: "",
        issueDate: today(),
        dueDate: today(),
        gross: "",
        vat: "",
        category: "",
      });
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function pay(invoice: PurchaseInvoice) {
    const raw = paymentDrafts[invoice.id] ?? String(invoice.open).replace(".", ",");
    const amount = parseFinnishNumber(raw);
    if (amount === null || amount <= 0) {
      setMessage("Anna maksun summa, esim. 124,00.");
      return;
    }
    setBusy(true);
    try {
      const response = await apiFetch(`/api/purchase-invoices/${invoice.id}/payments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, paidDate: today() }),
      });
      await readJson(response, "Maksun kirjaus epäonnistui");
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Maksun kirjaus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(invoice: PurchaseInvoice) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/purchase-invoices/${invoice.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await readJson(response, "Poisto epäonnistui");
      setConfirmRemove(null);
      await load();
    } catch (error) {
      const message = errorMessage(error, "Poisto epäonnistui");
      setMessage(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function runBankMatch() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/purchase-invoices/match", {
        method: "POST",
        credentials: "include",
      });
      const result = await readJson<{ applied: unknown[]; suggestions: unknown[] }>(
        response,
        "Kohdistus epäonnistui"
      );
      setMessage(
        `Kohdistettiin ${result.applied.length} maksua viitenumerolla. ` +
          `${result.suggestions.length} mahdollista osumaa vaatii tarkistuksen.`
      );
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Kohdistus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  const field = `${controlClass} min-h-12`;
  const label = "text-sm font-medium text-charcoal";

  return (
    <>
      <div className="space-y-6 pb-6">
        <header className="space-y-2">
          <p className="text-sm text-warm-gray leading-relaxed">
            Mitä olet velkaa ja milloin. ALV-raportti lasketaan edelleen kuiteista, joten sama
            osto ei kirjaudu kahdesti.
          </p>
        </header>

        {aging && (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
            <p className="text-sm text-warm-gray">Avoimet ostovelat</p>
            <p className="text-3xl font-semibold text-charcoal tracking-tight">
              {formatEur(aging.totalOpen)}
            </p>
            {aging.overdueCount > 0 && (
              <p className="text-xs text-danger">
                {formatEur(aging.overdue)} myöhässä ({aging.overdueCount} laskua)
              </p>
            )}
            <div className="grid grid-cols-4 gap-2 pt-1 text-center">
              {["1-30", "31-60", "61-90", "90+"].map((bucket) => (
                <div key={bucket} className="rounded-xl bg-cream/70 py-2">
                  <p className="text-[11px] text-warm-gray">{bucket} pv</p>
                  <p className="text-xs font-medium text-charcoal">
                    {formatEur((aging.buckets[bucket]?.openCents ?? 0) / 100)}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {message && (
          <p className="text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3" role="status">
            {message}
          </p>
        )}

        {creating ? (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
            <p className="text-base font-medium text-charcoal">Uusi ostolasku</p>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <label className={label} htmlFor="pi-supplier">Toimittaja</label>
                <input
                  id="pi-supplier"
                  className={field}
                  value={form.supplierName}
                  onChange={(e) => setForm({ ...form, supplierName: e.target.value })}
                  placeholder="Tukku Oy"
                  maxLength={120}
                />
                {formErrors.supplierName && (
                  <p className="text-xs text-danger">{formErrors.supplierName}</p>
                )}
              </div>

              <div className="field-grid">
                <div className="space-y-1.5">
                  <label className={label} htmlFor="pi-gross">Summa (€)</label>
                  <input
                    id="pi-gross"
                    className={field}
                    value={form.gross}
                    onChange={(e) => setForm({ ...form, gross: e.target.value })}
                    inputMode="decimal"
                  />
                  {formErrors.gross && <p className="text-xs text-danger">{formErrors.gross}</p>}
                </div>
                <div className="space-y-1.5">
                  <label className={label} htmlFor="pi-vat">ALV (€)</label>
                  <input
                    id="pi-vat"
                    className={field}
                    value={form.vat}
                    onChange={(e) => setForm({ ...form, vat: e.target.value })}
                    inputMode="decimal"
                    placeholder="0,00"
                  />
                  {formErrors.vat && <p className="text-xs text-danger">{formErrors.vat}</p>}
                </div>
              </div>

              <div className="field-dates">
                <div className="space-y-1.5">
                  <label className={label} htmlFor="pi-issue">Laskun päivä</label>
                  <input
                    id="pi-issue"
                    type="date"
                    className={field}
                    value={form.issueDate}
                    onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className={label} htmlFor="pi-due">Eräpäivä</label>
                  <input
                    id="pi-due"
                    type="date"
                    className={field}
                    value={form.dueDate}
                    onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                  />
                  {formErrors.dueDate && <p className="text-xs text-danger">{formErrors.dueDate}</p>}
                </div>
              </div>

              <div className="field-grid">
                <div className="space-y-1.5">
                  <label className={label} htmlFor="pi-reference">Viitenumero</label>
                  <input
                    id="pi-reference"
                    className={field}
                    value={form.reference}
                    onChange={(e) => setForm({ ...form, reference: e.target.value })}
                    inputMode="numeric"
                    maxLength={30}
                  />
                  {formErrors.reference ? (
                    <p className="text-xs text-danger">{formErrors.reference}</p>
                  ) : (
                    <p className="text-xs text-warm-gray">Tarvitaan automaattiseen kohdistukseen.</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className={label} htmlFor="pi-number">Laskun numero</label>
                  <input
                    id="pi-number"
                    className={field}
                    value={form.invoiceNumber}
                    onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })}
                    maxLength={40}
                  />
                </div>
              </div>

              <div className="flex gap-3">
                <Button type="button" variant="secondary" className="flex-1" onClick={() => setCreating(false)}>
                  Peruuta
                </Button>
                <Button type="submit" className="flex-1" busy={busy} busyLabel="Tallennetaan…">
                  Lisää ostolasku
                </Button>
              </div>
            </form>
          </section>
        ) : (
          <div className="flex gap-3">
            <Button type="button" className="flex-1" onClick={() => setCreating(true)}>
              Uusi ostolasku
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void runBankMatch()}
              busy={busy}
              busyLabel="Kohdistetaan…"
            >
              Kohdista maksut
            </Button>
          </div>
        )}

        <div className="flex gap-2 overflow-x-auto scrollbar-none">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              aria-pressed={filter === entry.id}
              className={chipClass(filter === entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {loadFailure != null && status === "ready" && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("purchases")} onRetry={() => void load()} />
        )}
        {status === "loading" && <LoadingState label="Haetaan ostolaskuja…" />}
        {status === "error" &&
          (isForbidden(loadFailure) ? (
            <EmptyState kind="forbidden" />
          ) : (
            <ConnectionNotice
              error={loadFailure}
              fallback={message || "Ostolaskujen haku epäonnistui"}
              onRetry={() => void load()}
            />
          ))}

        {status === "ready" && (
          <ul className="space-y-3">
            {invoices.map((invoice) => (
              <li
                key={invoice.id}
                className={`bg-white rounded-3xl border shadow-sm overflow-hidden ${
                  invoice.displayStatus === "overdue"
                    ? "border-danger/30"
                    : "border-warm-gray-light/20"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === invoice.id ? null : invoice.id)}
                  className="w-full text-left p-5 space-y-2"
                  aria-expanded={expanded === invoice.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-medium text-charcoal truncate">
                        {invoice.supplierName}
                      </p>
                      <p className="text-xs text-warm-gray">
                        Eräpäivä {formatDate(invoice.dueDate)}
                        {invoice.invoiceNumber ? ` · ${invoice.invoiceNumber}` : ""}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-base font-semibold text-charcoal">
                        {formatEur(invoice.gross)}
                      </p>
                      {invoice.open !== invoice.gross && invoice.open !== 0 && (
                        <p className="text-[11px] text-warm-gray">
                          avoinna {formatEur(invoice.open)}
                        </p>
                      )}
                    </div>
                  </div>
                  <span
                    className={`inline-block text-[11px] font-medium px-2.5 py-1 rounded-full ${
                      STATUS_CLASS[invoice.displayStatus]
                    }`}
                  >
                    {STATUS_LABEL[invoice.displayStatus]}
                  </span>
                </button>

                {expanded === invoice.id && (
                  <div className="border-t border-warm-gray-light/25 p-5 space-y-3 bg-cream/40">
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="text-warm-gray">Veroton</p>
                        <p className="text-charcoal font-medium">{formatEur(invoice.net)}</p>
                      </div>
                      <div>
                        <p className="text-warm-gray">ALV</p>
                        <p className="text-charcoal font-medium">{formatEur(invoice.vat)}</p>
                      </div>
                      <div>
                        <p className="text-warm-gray">Maksettu</p>
                        <p className="text-charcoal font-medium">{formatEur(invoice.paid)}</p>
                      </div>
                    </div>

                    {invoice.reference && (
                      <p className="text-xs text-warm-gray">Viite {invoice.reference}</p>
                    )}

                    {invoice.status === "open" && (
                      <div className="flex gap-2">
                        <input
                          aria-label={`Maksun summa: ${invoice.supplierName}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-warm-gray-light/60 text-sm"
                          value={
                            paymentDrafts[invoice.id] ?? String(invoice.open).replace(".", ",")
                          }
                          onChange={(e) =>
                            setPaymentDrafts({ ...paymentDrafts, [invoice.id]: e.target.value })
                          }
                          inputMode="decimal"
                        />
                        <button
                          type="button"
                          onClick={() => void pay(invoice)}
                          disabled={busy}
                          className="px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-50"
                        >
                          Merkitse maksetuksi
                        </button>
                      </div>
                    )}

                    {invoice.payments.length > 0 && (
                      <ul className="space-y-1 text-xs text-warm-gray">
                        {invoice.payments.map((payment) => (
                          <li key={payment.id}>
                            {formatDate(payment.paidDate)} · {formatEur(payment.amount)}
                            {payment.source === "bank" ? " · pankista" : ""}
                          </li>
                        ))}
                      </ul>
                    )}

                    {invoice.payments.length === 0 && (
                      <button
                        type="button"
                        onClick={() => setConfirmRemove(invoice)}
                        className="text-xs font-medium px-3 py-2 rounded-xl border border-danger/40 text-danger"
                      >
                        Poista
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}

            {invoices.length === 0 && (
              <EmptyState
                kind={filter !== "all" ? "filtered" : "records"}
                title={filter !== "all" ? "Ei ostolaskuja tällä suodattimella" : "Ei ostolaskuja vielä"}
                body={filter !== "all" ? "Kokeile toista suodatinta." : "Lisää ensimmäinen ostolasku."}
                onClear={filter !== "all" ? () => setFilter("all") : undefined}
                clearLabel="Tyhjennä suodatin"
              />
            )}
          </ul>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmRemove !== null}
        title="Poistetaanko ostolasku?"
        description={confirmRemove ? `${confirmRemove.supplierName} · ${formatEur(confirmRemove.gross)}` : ""}
        confirmLabel="Poista"
        onConfirm={() => (confirmRemove ? remove(confirmRemove) : Promise.resolve())}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
