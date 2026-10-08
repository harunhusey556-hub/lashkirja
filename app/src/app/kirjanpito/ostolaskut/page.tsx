"use client";

import { AnimatedRows } from "@/components/AnimatedRows";
import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { Reveal } from "@/components/ds/Reveal";
import { useCallback, useEffect, useState } from "react";
import { SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
import {
  apiFetch,
  errorMessage,
  fieldErrorsFromApi,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { routeFieldErrors } from "@/lib/field-error-routing";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";
import { formatDate, formatDayMonth, formatEur, parseFinnishNumber } from "@/lib/format";
import { moneyEntryProblem } from "@/lib/money-entry";
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
  HeaderAddPill,
  KeyValueList,
  ListRow,
  PageTitle,
  Section,
  SlotSkeleton,
  StatusTag,
  SummaryCard,
  useSkeletonFade,
} from "@/components/ds";
import { ReceiptText } from "lucide-react";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { isForbidden } from "@/lib/screen-state";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { useCachedResource } from "@/components/useCachedResource";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { PURCHASE_COUNTS_KEY } from "@/lib/cached-resource";
import { tintedButtonClass } from "@/components/control-styles";
import { PURCHASE_VAT_TREATMENTS, type PurchaseVatTreatment } from "@/lib/alv";
import { VAT_TREATMENT_HINTS, VAT_TREATMENT_LABELS } from "@/lib/foreign-purchase";

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
  /** The receipt that documents this purchase: its VAT counts through the receipt (F39). */
  receiptId?: string | null;
  payments: Array<{ id: string; paidDate: string; amount: number; source: string }>;
}

interface ReceiptChoice {
  id: string;
  vendor: string | null;
  date: string | null;
  gross: number | null;
  reviewStatus: string;
  sameAmount: boolean;
}

/** "Kauppa · 12.8.2026 · 124,00 €", whatever of it is known. */
function receiptChoiceText(receipt: ReceiptChoice): string {
  return [
    receipt.vendor?.trim() || "Kuitti",
    receipt.date ? formatDate(receipt.date) : null,
    receipt.gross == null ? null : formatEur(receipt.gross),
  ]
    .filter(Boolean)
    .join(" · ");
}

interface Aging {
  buckets: Record<string, { count: number; openCents: number }>;
  totalOpen: number;
  overdue: number;
  overdueCount: number;
}

const PENDING_CHIP_LABELS: Array<{ id: PurchaseFilterId; label: string }> = [
  { id: "all", label: "Kaikki" },
  { id: "overdue", label: "Myöhässä" },
  { id: "open", label: "Odottaa maksua" },
  { id: "paid", label: "Maksetut" },
];
const AGING_BUCKETS = ["1-30", "31-60", "61-90", "90+"] as const;

/** The fields the "Uusi ostolasku" form shows an error under. */
const PURCHASE_FORM_SLOTS = ["supplierName", "gross", "vat", "dueDate", "reference"];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * "<number> · eräpäivä d.m. · avoinna X" - "myöhässä" once overdue, no invoice
 * number when there is none, and the trailing "avoinna" clause only when the
 * invoice is partially paid (paid something, but not the full amount yet) -
 * otherwise the open amount already equals the row's own gross figure and
 * repeating it here would be redundant.
 */
function rowSecondary(invoice: PurchaseInvoice): string {
  const datePhrase = invoice.displayStatus === "overdue" ? "myöhässä, eräpäivä" : "eräpäivä";
  const dateText = `${datePhrase} ${formatDayMonth(invoice.dueDate)}`;
  // Without an invoice number the date phrase starts the line, so it starts with a capital.
  const base = invoice.invoiceNumber
    ? `${invoice.invoiceNumber} · ${dateText}`
    : dateText.charAt(0).toUpperCase() + dateText.slice(1);
  const partiallyPaid = invoice.paid > 0 && invoice.open > 0;
  return partiallyPaid ? `${base} · avoinna ${formatEur(invoice.open)}` : base;
}

export default function PurchaseInvoicesPage() {
  const cached = readPageCache<{ invoices: PurchaseInvoice[]; aging: Aging }>("purchases");
  const [invoices, setInvoices] = useState<PurchaseInvoice[]>(cached?.invoices ?? []);
  const [aging, setAging] = useState<Aging | null>(cached?.aging ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton (N3).
  const lateCache = useCacheAfterBoot<{ invoices: PurchaseInvoice[]; aging: Aging }>("purchases");
  const [appliedLateCache, setAppliedLateCache] = useState<unknown>(null);
  // Content that replaces the skeleton fades in (owner report 2026-09-30: fluidity).
  const readyFade = useSkeletonFade(status === "loading");
  if (lateCache && lateCache !== appliedLateCache && status === "loading") {
    setAppliedLateCache(lateCache);
    setInvoices(lateCache.invoices);
    setAging(lateCache.aging);
    setStatus("ready");
  }
  // Persisted so back-navigation restores the active tab instead of resetting
  // the list to "Kaikki" - default "all" (not "open") so a purely overdue
  // book (no invoice merely "open" yet) doesn't open on an empty tab, same
  // default as /laskut.
  const [filter, setFilter] = usePersistedState<PurchaseFilterId>("ostolaskut.filter", "all");
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<PurchaseInvoice | null>(null);
  const [detailInvoice, setDetailInvoice] = useState<PurchaseInvoice | null>(null);
  const [confirmRemovePayment, setConfirmRemovePayment] = useState<{
    invoiceId: string;
    paymentId: string;
    amount: number;
  } | null>(null);
  // M1-2: the receipt linked to the open invoice and the ones that could be the same purchase.
  const [receiptLinks, setReceiptLinks] = useState<{ linked: ReceiptChoice | null; candidates: ReceiptChoice[] } | null>(null);
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
    vatTreatment: "domestic" as PurchaseVatTreatment,
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
      // Shown once, by ConnectionNotice/StaleBanner below; never a second banner (BOOKS-15).
      setLoadFailure(error);
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
  // every mutation below (create/pay/remove/match) - a bare mount fetch only
  // ever counted once, and every chip went stale the moment the first invoice
  // was created, paid or removed. Painted from the cache (shared with the
  // Kirjanpito hub row) so the counts never start from a fake zero (N3).
  const { value: statusCounts, failed: countsFailed, reload: reloadCounts } = useCachedResource<PurchaseStatusCounts>(
    PURCHASE_COUNTS_KEY,
    async (signal) => {
      const response = await apiFetch("/api/purchase-invoices/counts", { credentials: "include", signal });
      return (await readJson<{ counts: PurchaseStatusCounts }>(response, "Määrien haku epäonnistui")).counts;
    }
  );

  useScrollRestoration("ostolaskut", status === "ready");

  function validate() {
    const errors: Record<string, string> = {};
    if (!form.supplierName.trim()) errors.supplierName = "Anna toimittajan nimi.";
    const gross = parseFinnishNumber(form.gross);
    if (gross === null || gross <= 0) errors.gross = "Anna laskun summa, esim. 124,00.";
    else {
      const problem = moneyEntryProblem(gross);
      if (problem) errors.gross = problem;
    }
    const vat = form.vat.trim() ? parseFinnishNumber(form.vat) : 0;
    if (vat === null || vat < 0) errors.vat = "ALV on virheellinen.";
    else {
      const problem = moneyEntryProblem(vat);
      if (problem) errors.vat = problem;
    }
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
      vatTreatment: form.vatTreatment,
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
        vatTreatment: "domestic",
      });
      setFormErrors({});
      await Promise.all([load(), reloadCounts()]);
    } catch (error) {
      // Renders inside the "Uusi ostolasku" sheet, which stays open, not the
      // page-level message behind it.
      // A refusal that names fields is shown at those fields (F64).
      const routed = routeFieldErrors(fieldErrorsFromApi(error), (key) => PURCHASE_FORM_SLOTS.includes(key));
      if (Object.keys(routed.fields).length > 0) {
        setFormErrors(routed.fields);
        setCreateError("");
      } else {
        // A field the form shows no slot for (a date) would vanish: its message is the generic one.
        setCreateError(routed.message || errorMessage(error, "Tallennus epäonnistui"));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Opens the detail sheet with a clean slate: no stale error, draft reset to the current open balance. */
  function openDetail(invoice: PurchaseInvoice) {
    setDetailInvoice(invoice);
    setPaymentDraft(String(invoice.open > 0 ? invoice.open : "").replace(".", ","));
    setPayError("");
    void loadReceiptLinks(invoice.id);
  }

  async function loadReceiptLinks(invoiceId: string) {
    setReceiptLinks(null);
    try {
      const response = await apiFetch(`/api/purchase-invoices/${invoiceId}/receipts`, { credentials: "include" });
      setReceiptLinks(
        await readJson<{ linked: ReceiptChoice | null; candidates: ReceiptChoice[] }>(response, "Kuittien haku epäonnistui")
      );
    } catch {
      // The link control is a convenience; the sheet works without it.
      setReceiptLinks(null);
    }
  }

  /** Links the receipt of the same purchase to the invoice, or removes the link (receiptId null). */
  async function setReceiptLink(invoice: PurchaseInvoice, receiptId: string | null) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/purchase-invoices/${invoice.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptId }),
      });
      const data = await readJson<{ invoice: PurchaseInvoice }>(response, "Kuitin liittäminen epäonnistui");
      setDetailInvoice(data.invoice);
      showToast({ tone: "success", text: receiptId ? "Kuitti liitettiin" : "Liitos poistettiin" });
      await Promise.all([load(), reloadCounts(), loadReceiptLinks(invoice.id)]);
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Kuitin liittäminen epäonnistui") });
    } finally {
      setBusy(false);
    }
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
      await Promise.all([load(), reloadCounts()]);
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
      await Promise.all([load(), reloadCounts()]);
    } catch (error) {
      const failureMessage = errorMessage(error, "Poisto epäonnistui");
      setMessage(failureMessage);
      throw new Error(failureMessage);
    } finally {
      setBusy(false);
    }
  }

  /** The way back from a wrong payment, or an overpayment that was booked before it was refused. */
  async function removePayment(target: { invoiceId: string; paymentId: string }) {
    setBusy(true);
    try {
      const response = await apiFetch(
        `/api/purchase-invoices/${target.invoiceId}/payments?paymentId=${encodeURIComponent(target.paymentId)}`,
        { method: "DELETE", credentials: "include" }
      );
      await readJson(response, "Maksun poisto epäonnistui");
      setConfirmRemovePayment(null);
      showToast({ tone: "success", text: "Maksu poistettiin" });
      await Promise.all([load(), reloadCounts()]);
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      throw new Error(errorMessage(error, "Maksun poisto epäonnistui"));
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
      // The outcome as a toast (BOOKS-29): it confirms the bulk write where the user is looking.
      void hapticNotify("success");
      showToast({
        tone: "success",
        text:
          result.applied.length === 0 && result.suggestions.length === 0
            ? "Ei kohdistettavia maksuja."
            : `Kohdistettiin ${result.applied.length} maksua viitenumerolla. ` +
              `${result.suggestions.length} mahdollista osumaa vaatii tarkistuksen.`,
      });
      await Promise.all([load(), reloadCounts()]);
    } catch (error) {
      void hapticNotify("error");
      showToast({ tone: "error", text: errorMessage(error, "Kohdistus epäonnistui") });
    } finally {
      setBusy(false);
    }
  }

  const field = `${controlClass} min-h-12`;
  const label = "mb-1.5 block text-caption font-normal text-ink-2";

  // Counts not known yet (first ever visit): the chips are there at their final
  // size with a skeleton where the number goes, never a zero.
  const filterChips = statusCounts
    ? purchaseFilterChips(statusCounts)
    : PENDING_CHIP_LABELS.map(({ id, label }) => ({ id, label, count: countsFailed ? undefined : <SlotSkeleton width={14} /> }));
  const groups = purchaseInvoiceGroups(invoices, filter);
  const visibleCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const filtered = filter !== "all";
  // Nothing to show yet, or the load failed: no aging table, no match button, no chips (VS-30).
  const noPurchases = status === "error" || (status === "ready" && visibleCount === 0 && !filtered);
  const reachedListLimit = invoices.length === PURCHASE_LIST_LIMIT;

  return (
    <>
      <div className="space-y-6">
        {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
        <PullToRefresh onRefresh={() => {
            reloadCounts();
            return load();
          }} />
        <PageTitle
          title="Ostolaskut"
          subtitle="Mitä olet velkaa ja milloin."
          action={<HeaderAddPill label="Uusi ostolasku" onClick={() => setCreateOpen(true)} />}
        />

        {aging && !noPurchases && (
          <>
            <SummaryCard
              label="Avoinna"
              value={formatEur(aging.totalOpen)}
              note={aging.overdueCount > 0 ? `${formatEur(aging.overdue)} myöhässä` : undefined}
            />
            <div className="grid grid-cols-4 divide-x divide-line overflow-hidden rounded-card border border-line bg-surface text-center">
              {AGING_BUCKETS.map((bucket) => (
                <div key={bucket} className="px-2 py-3">
                  <p className="text-micro text-ink-2">{bucket} pv</p>
                  <p className="mt-0.5 text-caption font-medium tabular-nums text-ink">
                    {formatEur((aging.buckets[bucket]?.openCents ?? 0) / 100)}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        {!noPurchases && (
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
        )}

        <Reveal show={Boolean(message)}>{message ? (
          <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
            {message}
          </p>
        ) : null}</Reveal>

        {!noPurchases && (
          <FilterChips label="Suodata ostolaskut" items={filterChips} value={filter} onChange={setFilter} />
        )}

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
          <div className={readyFade || undefined}>
            {groups.map((group) => (
              <Section key={group.id} title={group.label}>
                <AnimatedRows rows={group.items.map((invoice) => ({ key: invoice.id, node: (
                  <ListRow
                    key={invoice.id}
                    onClick={() => openDetail(invoice)}
                    title={invoice.supplierName}
                    amount={formatEur(invoice.gross)}
                    secondary={rowSecondary(invoice)}
                    trailing={
                      <StatusTag tone={PURCHASE_STATUS[invoice.displayStatus].tone}>
                        {PURCHASE_STATUS[invoice.displayStatus].label}
                      </StatusTag>
                    }
                  />
                ) }))} />
              </Section>
            ))}

            {visibleCount === 0 && (
              <EmptyState
                kind={filtered ? "filtered" : "records"}
                icon={ReceiptText}
                title={filtered ? "Ei ostolaskuja tällä suodattimella" : "Ei ostolaskuja vielä"}
                body={filtered ? "Kokeile toista suodatinta." : "Tähän ilmestyvät saamasi ostolaskut ja niiden eräpäivät."}
                onCreate={filtered ? undefined : () => setCreateOpen(true)}
                createLabel="Uusi ostolasku"
                onClear={filtered ? () => setFilter("all") : undefined}
                clearLabel="Tyhjennä suodatin"
              />
            )}

            {reachedListLimit && (
              <p className="text-caption text-ink-2">
                Näytetään {PURCHASE_LIST_LIMIT} vanhinta erääntyvää laskua. Valitse suodatin nähdäksesi kaikki.
              </p>
            )}
          </div>
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
                enterKeyHint="next"
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
                enterKeyHint="next"
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
                enterKeyHint="next"
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
              <div>
                <label className={label} htmlFor="pi-vat-treatment">ALV-käsittely</label>
                <select
                  id="pi-vat-treatment"
                  className={field}
                  value={form.vatTreatment}
                  onChange={(e) => setForm({ ...form, vatTreatment: e.target.value as PurchaseVatTreatment })}
                >
                  {PURCHASE_VAT_TREATMENTS.map((treatment) => (
                    <option key={treatment} value={treatment}>
                      {VAT_TREATMENT_LABELS[treatment]}
                    </option>
                  ))}
                </select>
                {form.vatTreatment !== "domestic" && (
                  <p className="mt-1.5 text-caption text-ink-2">{VAT_TREATMENT_HINTS[form.vatTreatment]}</p>
                )}
              </div>
            </div>
            {/* F39: the rule, where the amount is typed. */}
            <p className="-mt-1 text-caption text-ink-2">
              Laskun ALV on mukana ALV-ilmoituksen vähennettävässä verossa laskun päivän mukaan. Jos sama osto on myös
              kuittina, liitä kuitti laskuun, niin ALV ei lasketa kahdesti.
            </p>

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
                enterKeyHint="next"
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
                enterKeyHint="done"
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
                ...(detailInvoice.reference
                  ? [{ label: "Viite", value: detailInvoice.reference, copy: { text: detailInvoice.reference, what: "Viitenumero" } }]
                  : []),
                ...(detailInvoice.payments.length > 0
                  ? [{ label: "Maksettu", value: formatEur(detailInvoice.paid) }]
                  : []),
                ...(detailInvoice.status === "open"
                  ? [{ label: "Avoinna", value: formatEur(detailInvoice.open) }]
                  : []),
              ]}
            />
            {detailInvoice.status !== "cancelled" && detailInvoice.vat > 0 ? (
              <p className="text-caption text-ink-2">
                {detailInvoice.receiptId
                  ? "Kuitti on liitetty: ALV lasketaan kuitin kautta, kun kuitti on hyväksytty ja siinä on ALV-erittely."
                  : "ALV on mukana ALV-ilmoituksen vähennettävässä verossa."}
              </p>
            ) : null}

            {detailInvoice.status !== "cancelled" && receiptLinks?.linked ? (
              <div className="space-y-2">
                <p className="text-caption text-ink-2">Liitetty kuitti: {receiptChoiceText(receiptLinks.linked)}</p>
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  disabled={busy}
                  onClick={() => void setReceiptLink(detailInvoice, null)}
                >
                  Poista liitos
                </Button>
              </div>
            ) : null}

            {detailInvoice.status !== "cancelled" && receiptLinks && !receiptLinks.linked && receiptLinks.candidates.length > 0 ? (
              <div className="space-y-2">
                <p className="text-caption text-ink-2">
                  Onko tämä osto jo kuittina? Liitä kuitti, niin ALV ei lasketa kahdesti.
                </p>
                <ul className="space-y-1">
                  {receiptLinks.candidates.map((receipt) => (
                    <li key={receipt.id} className="flex items-center justify-between gap-3 text-caption text-ink">
                      <span className="min-w-0 truncate">{receiptChoiceText(receipt)}</span>
                      <button
                        type="button"
                        className={tintedButtonClass("accent", "shrink-0")}
                        disabled={busy}
                        aria-label={`Liitä kuitti ${receiptChoiceText(receipt)}`}
                        onClick={() => void setReceiptLink(detailInvoice, receipt.id)}
                      >
                        Liitä kuitti
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {detailInvoice.payments.length > 0 && (
              <ul className="space-y-1 text-caption text-ink-2">
                {detailInvoice.payments.map((payment) => (
                  <li key={payment.id} className="flex items-center justify-between gap-3">
                    <span>
                      {formatDate(payment.paidDate)} · {formatEur(payment.amount)}
                      {payment.source === "bank" ? " · pankista" : ""}
                    </span>
                    <button
                      type="button"
                      className="active-press min-h-11 shrink-0 px-2 text-caption font-semibold text-danger disabled:opacity-50"
                      disabled={busy}
                      aria-label={`Poista maksu ${formatEur(payment.amount)}`}
                      onClick={() => {
                        setConfirmRemovePayment({
                          invoiceId: detailInvoice.id,
                          paymentId: payment.id,
                          amount: payment.amount,
                        });
                        setDetailInvoice(null);
                      }}
                    >
                      Poista maksu
                    </button>
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

            {detailInvoice.payments.length === 0 && (
              <Button
                type="button"
                variant="danger"
                className="w-full"
                disabled={busy}
                onClick={() => {
                  setConfirmRemove(detailInvoice);
                  setDetailInvoice(null);
                }}
              >
                Poista ostolasku
              </Button>
            )}
          </div>
        )}
      </BottomSheet>

      <ConfirmModal
        isOpen={confirmRemovePayment !== null}
        title="Poistetaanko maksu?"
        description={
          confirmRemovePayment
            ? `${formatEur(confirmRemovePayment.amount)} poistetaan ostolaskulta. Ostolasku palaa avoimeksi, jos se ei ole sen jälkeen kokonaan maksettu.`
            : ""
        }
        confirmLabel="Poista maksu"
        onConfirm={() => (confirmRemovePayment ? removePayment(confirmRemovePayment) : Promise.resolve())}
        onCancel={() => setConfirmRemovePayment(null)}
      />

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
