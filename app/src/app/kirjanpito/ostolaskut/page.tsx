"use client";

import { useCallback, useEffect, useState } from "react";
import { SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDate, formatDayMonth, formatEur, parseFinnishNumber } from "@/lib/format";
import { isValidReferenceNumber, normalizeReference } from "@/lib/finnish-reference";
import { PURCHASE_STATUS } from "@/lib/status-labels";
import {
  PURCHASE_LIST_LIMIT,
  purchaseFilterChips,
  purchaseInvoiceGroups,
  type PurchaseFilterId,
  type PurchaseStatusCounts,
} from "@/lib/purchase-invoice-groups";

import { Button, controlClass } from "@/components/ui";
import {
  FilterChips,
  Icon,
  KeyValueList,
  ListRow,
  MoreMenu,
  PageTitle,
  Section,
  StatusTag,
  SummaryCard,
} from "@/components/ds";
import { Plus } from "lucide-react";
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

const ZERO_COUNTS: PurchaseStatusCounts = { overdue: 0, open: 0, paid: 0, cancelled: 0 };
const AGING_BUCKETS = ["1-30", "31-60", "61-90", "90+"] as const;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * "<number> · eräpäivä d.m. · avoinna X" - "erääntyi" once overdue, no invoice
 * number when there is none, and the trailing "avoinna" clause only when the
 * invoice is partially paid (paid something, but not the full amount yet) -
 * otherwise the open amount already equals the row's own gross figure and
 * repeating it here would be redundant.
 */
function rowSecondary(invoice: PurchaseInvoice): string {
  const datePhrase = invoice.displayStatus === "overdue" ? "erääntyi" : "eräpäivä";
  const dateText = `${datePhrase} ${formatDayMonth(invoice.dueDate)}`;
  // Without an invoice number the date phrase starts the line, so it starts with a capital.
  const base = invoice.invoiceNumber
    ? `${invoice.invoiceNumber} · ${dateText}`
    : dateText.charAt(0).toUpperCase() + dateText.slice(1);
  const partiallyPaid = invoice.paid > 0 && invoice.open > 0;
  return partiallyPaid ? `${base} · avoinna ${formatEur(invoice.open)}` : base;
}

/** A unique accessible name per row's "..." menu: two rows can share a supplier name. */
function rowMenuLabel(invoice: PurchaseInvoice): string {
  const suffix = invoice.invoiceNumber ? invoice.invoiceNumber : formatDayMonth(invoice.dueDate);
  return `Lisää toimintoja: ${invoice.supplierName} ${suffix}`;
}

export default function PurchaseInvoicesPage() {
  const cached = readPageCache<{ invoices: PurchaseInvoice[]; aging: Aging }>("purchases");
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>(cached?.invoices ?? []);
  const [aging, setAging] = useState<Aging | null>(cached?.aging ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  // Persisted so back-navigation restores the active tab instead of resetting
  // the list to "Kaikki" - default "all" (not "open") so a purely overdue
  // book (no invoice merely "open" yet) doesn't open on an empty tab, same
  // default as /laskut.
  const [filter, setFilter] = usePersistedState<PurchaseFilterId>("ostolaskut.filter", "all");
  const [statusCounts, setStatusCounts] = useState<PurchaseStatusCounts>(ZERO_COUNTS);
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<PurchaseInvoice | null>(null);
  const [detailInvoice, setDetailInvoice] = useState<PurchaseInvoice | null>(null);
  const [paymentDraft, setPaymentDraft] = useState("");
  const [payError, setPayError] = useState("");

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
  const [createError, setCreateError] = useState("");

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

  // Filter-chip counts: fetched separately from the (capped) list above, so
  // every chip stays correct regardless of which tab is active. Re-run after
  // every mutation below (create/pay/remove/match) - a bare [] effect only
  // ever counted once, at mount, and every chip went stale the moment the
  // first invoice was created, paid or removed.
  const loadCounts = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await apiFetch("/api/purchase-invoices/counts", {
        credentials: "include",
        signal,
      });
      const data = await readJson<{ counts: PurchaseStatusCounts }>(response, "Määrien haku epäonnistui");
      if (signal?.aborted) return;
      setStatusCounts(data.counts);
    } catch (error) {
      if (signal?.aborted) return;
      if (isUnauthorized(error)) redirectToLogin();
      // Otherwise leave the last-known (or zero) counts - the invoice list
      // itself still loads independently of this fetch.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount/refetch: storing the fetched counts is exactly the external-system sync this effect exists for
    void loadCounts(controller.signal);
    return () => controller.abort();
  }, [loadCounts]);

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
    setCreateError("");
    try {
      const response = await apiFetch("/api/purchase-invoices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await readJson(response, "Tallennus epäonnistui");
      setCreateOpen(false);
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
      setFormErrors({});
      await Promise.all([load(), loadCounts()]);
    } catch (error) {
      // Renders inside the "Uusi ostolasku" sheet, which stays open, not the
      // page-level message behind it.
      setCreateError(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  /** Opens the detail sheet with a clean slate: no stale error, draft reset to the current open balance. */
  function openDetail(invoice: PurchaseInvoice) {
    setDetailInvoice(invoice);
    setPaymentDraft(String(invoice.open > 0 ? invoice.open : "").replace(".", ","));
    setPayError("");
  }

  async function pay() {
    if (!detailInvoice) return;
    const amount = parseFinnishNumber(paymentDraft);
    if (amount === null || amount <= 0) {
      setPayError("Anna maksun summa, esim. 124,00.");
      return;
    }
    setPayError("");
    setBusy(true);
    try {
      const response = await apiFetch(`/api/purchase-invoices/${detailInvoice.id}/payments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, paidDate: today() }),
      });
      await readJson(response, "Maksun kirjaus epäonnistui");
      setDetailInvoice(null);
      await Promise.all([load(), loadCounts()]);
    } catch (error) {
      // Renders inside the detail sheet, which stays open.
      setPayError(errorMessage(error, "Maksun kirjaus epäonnistui"));
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
      await Promise.all([load(), loadCounts()]);
    } catch (error) {
      const failureMessage = errorMessage(error, "Poisto epäonnistui");
      setMessage(failureMessage);
      throw new Error(failureMessage);
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
      await Promise.all([load(), loadCounts()]);
    } catch (error) {
      setMessage(errorMessage(error, "Kohdistus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  const field = `${controlClass} min-h-12`;
  const label = "mb-1.5 block text-[13px] font-normal text-ink-2";

  const filterChips = purchaseFilterChips(statusCounts);
  const groups = purchaseInvoiceGroups(invoices, filter);
  const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const filtered = filter !== "all";
  const reachedListLimit = invoices.length === PURCHASE_LIST_LIMIT;

  return (
    <>
      <div className="space-y-6">
        <PageTitle
          title="Ostolaskut"
          subtitle="Mitä olet velkaa ja milloin."
          action={
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="active-press relative inline-flex min-h-9 items-center gap-1 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
            >
              <Icon icon={Plus} size="inline" strokeWidth={2.5} />
              Uusi ostolasku
            </button>
          }
        />

        {aging && (
          <>
            <SummaryCard
              label="Avoinna"
              value={formatEur(aging.totalOpen)}
              note={aging.overdueCount > 0 ? `${formatEur(aging.overdue)} myöhässä` : undefined}
            />
            <div className="grid grid-cols-4 divide-x divide-line overflow-hidden rounded-card border border-line bg-surface text-center">
              {AGING_BUCKETS.map((bucket) => (
                <div key={bucket} className="px-2 py-3">
                  <p className="text-[11px] text-ink-2">{bucket} pv</p>
                  <p className="mt-0.5 text-[13px] font-medium tabular-nums text-ink">
                    {formatEur((aging.buckets[bucket]?.openCents ?? 0) / 100)}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        <Button
          type="button"
          variant="secondary"
          onClick={() => void runBankMatch()}
          busy={busy}
          busyLabel="Kohdistetaan…"
          className="w-full"
        >
          Kohdista maksut
        </Button>

        {message && (
          <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
            {message}
          </p>
        )}

        <FilterChips label="Suodata ostolaskut" items={filterChips} value={filter} onChange={setFilter} />

        {loadFailure != null && status === "ready" && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("purchases")} onRetry={() => void load()} />
        )}
        {status === "loading" && <SkeletonList rows={4} />}
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
          <>
            {groups.map((group) => (
              <Section key={group.id} title={group.label} count={group.items.length}>
                {group.items.map((invoice) => (
                  <ListRow
                    key={invoice.id}
                    onClick={() => openDetail(invoice)}
                    title={invoice.supplierName}
                    amount={formatEur(invoice.gross)}
                    secondary={rowSecondary(invoice)}
                    trailing={
                      <div className="flex items-center gap-1.5">
                        <StatusTag tone={PURCHASE_STATUS[invoice.displayStatus].tone}>
                          {PURCHASE_STATUS[invoice.displayStatus].label}
                        </StatusTag>
                        <MoreMenu
                          label={rowMenuLabel(invoice)}
                          items={[
                            {
                              label: "Poista",
                              onSelect: () => setConfirmRemove(invoice),
                              tone: "danger" as const,
                              disabled: busy || invoice.payments.length > 0,
                            },
                          ]}
                        />
                      </div>
                    }
                  />
                ))}
              </Section>
            ))}

            {visibleCount === 0 && (
              <EmptyState
                kind={filtered ? "filtered" : "records"}
                title={filtered ? "Ei ostolaskuja tällä suodattimella" : "Ei ostolaskuja vielä"}
                body={filtered ? "Kokeile toista suodatinta." : "Lisää ensimmäinen ostolasku."}
                onClear={filtered ? () => setFilter("all") : undefined}
                clearLabel="Tyhjennä suodatin"
              />
            )}

            {reachedListLimit && (
              <p className="text-[13px] text-ink-2">
                Näytetään {PURCHASE_LIST_LIMIT} vanhinta erääntyvää laskua. Valitse suodatin nähdäksesi kaikki.
              </p>
            )}
          </>
        )}
      </div>

      <BottomSheet
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Uusi ostolasku"
        labelledBy="pi-create-title"
        heightClass="max-h-[94dvh]"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sheet-safe-bottom">
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div>
              <label className={label} htmlFor="pi-supplier">Toimittaja</label>
              <input
                id="pi-supplier"
                className={field}
                value={form.supplierName}
                onChange={(e) => setForm({ ...form, supplierName: e.target.value })}
                placeholder="Tukku Oy"
                maxLength={120}
                aria-invalid={Boolean(formErrors.supplierName) || undefined}
                aria-describedby={formErrors.supplierName ? "pi-supplier-error" : undefined}
              />
              {formErrors.supplierName && (
                <p id="pi-supplier-error" className="mt-1.5 text-sm text-danger" role="alert">
                  {formErrors.supplierName}
                </p>
              )}
            </div>

            <div className="field-grid">
              <div>
                <label className={label} htmlFor="pi-gross">Summa (€)</label>
                <input
                  id="pi-gross"
                  className={field}
                  value={form.gross}
                  onChange={(e) => setForm({ ...form, gross: e.target.value })}
                  inputMode="decimal"
                  aria-invalid={Boolean(formErrors.gross) || undefined}
                  aria-describedby={formErrors.gross ? "pi-gross-error" : undefined}
                />
                {formErrors.gross && (
                  <p id="pi-gross-error" className="mt-1.5 text-sm text-danger" role="alert">
                    {formErrors.gross}
                  </p>
                )}
              </div>
              <div>
                <label className={label} htmlFor="pi-vat">ALV (€)</label>
                <input
                  id="pi-vat"
                  className={field}
                  value={form.vat}
                  onChange={(e) => setForm({ ...form, vat: e.target.value })}
                  inputMode="decimal"
                  placeholder="0,00"
                  aria-invalid={Boolean(formErrors.vat) || undefined}
                  aria-describedby={formErrors.vat ? "pi-vat-error" : undefined}
                />
                {formErrors.vat && (
                  <p id="pi-vat-error" className="mt-1.5 text-sm text-danger" role="alert">
                    {formErrors.vat}
                  </p>
                )}
              </div>
            </div>

            <div className="field-dates">
              <div>
                <label className={label} htmlFor="pi-issue">Laskun päivä</label>
                <input
                  id="pi-issue"
                  type="date"
                  className={field}
                  value={form.issueDate}
                  onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
                />
              </div>
              <div>
                <label className={label} htmlFor="pi-due">Eräpäivä</label>
                <input
                  id="pi-due"
                  type="date"
                  className={field}
                  value={form.dueDate}
                  onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                  aria-invalid={Boolean(formErrors.dueDate) || undefined}
                  aria-describedby={formErrors.dueDate ? "pi-due-error" : undefined}
                />
                {formErrors.dueDate && (
                  <p id="pi-due-error" className="mt-1.5 text-sm text-danger" role="alert">
                    {formErrors.dueDate}
                  </p>
                )}
              </div>
            </div>

            <div className="field-grid">
              <div>
                <label className={label} htmlFor="pi-reference">Viitenumero</label>
                <input
                  id="pi-reference"
                  className={field}
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                  inputMode="numeric"
                  maxLength={30}
                  aria-invalid={Boolean(formErrors.reference) || undefined}
                  aria-describedby={formErrors.reference ? "pi-reference-error" : "pi-reference-hint"}
                />
                {formErrors.reference ? (
                  <p id="pi-reference-error" className="mt-1.5 text-sm text-danger" role="alert">
                    {formErrors.reference}
                  </p>
                ) : (
                  <p id="pi-reference-hint" className="mt-1.5 text-xs text-ink-2">
                    Tarvitaan automaattiseen kohdistukseen.
                  </p>
                )}
              </div>
              <div>
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

            {createError && (
              <p className="text-sm text-danger" role="alert">
                {createError}
              </p>
            )}

            <div className="flex gap-3">
              <Button type="button" variant="secondary" className="flex-1" onClick={() => setCreateOpen(false)}>
                Peruuta
              </Button>
              <Button type="submit" className="flex-1" busy={busy} busyLabel="Tallennetaan…">
                Lisää ostolasku
              </Button>
            </div>
          </form>
        </div>
      </BottomSheet>

      <BottomSheet
        isOpen={detailInvoice !== null}
        onClose={() => setDetailInvoice(null)}
        title={detailInvoice?.supplierName}
        labelledBy="pi-detail-title"
      >
        {detailInvoice && (
          <div className="space-y-4 px-5 py-4 sheet-safe-bottom">
            <StatusTag tone={PURCHASE_STATUS[detailInvoice.displayStatus].tone}>
              {PURCHASE_STATUS[detailInvoice.displayStatus].label}
            </StatusTag>

            <KeyValueList
              rows={[
                { label: "Eräpäivä", value: formatDate(detailInvoice.dueDate) },
                { label: "Veroton", value: formatEur(detailInvoice.net) },
                { label: "ALV", value: formatEur(detailInvoice.vat) },
                { label: "Yhteensä", value: formatEur(detailInvoice.gross) },
                ...(detailInvoice.reference ? [{ label: "Viite", value: detailInvoice.reference }] : []),
                ...(detailInvoice.payments.length > 0
                  ? [{ label: "Maksettu", value: formatEur(detailInvoice.paid) }]
                  : []),
                ...(detailInvoice.status === "open"
                  ? [{ label: "Avoinna", value: formatEur(detailInvoice.open) }]
                  : []),
              ]}
            />

            {detailInvoice.payments.length > 0 && (
              <ul className="space-y-1 text-[13px] text-ink-2">
                {detailInvoice.payments.map((payment) => (
                  <li key={payment.id}>
                    {formatDate(payment.paidDate)} · {formatEur(payment.amount)}
                    {payment.source === "bank" ? " · pankista" : ""}
                  </li>
                ))}
              </ul>
            )}

            {detailInvoice.status === "open" && (
              <div className="space-y-2">
                <input
                  aria-label="Maksun summa"
                  aria-invalid={Boolean(payError) || undefined}
                  aria-describedby={payError ? "pi-pay-error" : undefined}
                  className={field}
                  value={paymentDraft}
                  onChange={(e) => setPaymentDraft(e.target.value)}
                  inputMode="decimal"
                />
                {payError && (
                  <p id="pi-pay-error" className="text-sm text-danger" role="alert">
                    {payError}
                  </p>
                )}
                <Button
                  type="button"
                  className="w-full"
                  busy={busy}
                  busyLabel="Tallennetaan…"
                  onClick={() => void pay()}
                >
                  Merkitse maksetuksi
                </Button>
              </div>
            )}
          </div>
        )}
      </BottomSheet>

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
