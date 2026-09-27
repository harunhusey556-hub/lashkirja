"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LoadingState } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
import ConfirmModal from "@/components/ConfirmModal";
import {
  CustomerForm,
  type CustomerFormPayload,
} from "@/components/invoices/CustomerForm";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDate, formatEur } from "@/lib/format";
import { amountClass, longNameClass } from "@/lib/text-layout";

import { Button } from "@/components/ui";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { clearDraft } from "@/lib/draft-store";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { isForbidden } from "@/lib/screen-state";
interface Customer {
  id: string;
  name: string;
  businessId: string | null;
  email: string | null;
  phone: string | null;
  addressStreet: string | null;
  addressPostalCode: string | null;
  addressCity: string | null;
  defaultPaymentTermDays: number;
  notes: string | null;
  archivedAt: string | null;
  updatedAt?: string;
  invoiceCount: number;
  openInvoiceCount: number;
  openBalance: number;
  invoicedTotal: number;
  lastInvoiceDate: string | null;
}

export default function CustomersPage() {
  const cached = readPageCache<Customer[]>("customers");
  const [customers, setCustomers] = useState<Customer[]>(cached ?? []);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [search, setSearch] = usePersistedState("asiakkaat.search", "");
  const [showArchived, setShowArchived] = usePersistedState("asiakkaat.showArchived", false);
  const [formMode, setFormMode] = useState<"hidden" | "create" | { edit: Customer }>("hidden");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Customer | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [undo, setUndo] = useState<{ id: string; name: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("nimi,sähköposti,puhelin,y-tunnus\n");
  const [csvRows, setCsvRows] = useState<
    Array<{ line: number; name: string | null; errors: string[] }> | null
  >(null);
  const createKey = useRef(newIdempotencyKey());

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (showArchived) params.set("includeArchived", "1");
      if (search.trim()) params.set("search", search.trim());
      const response = await apiFetch(`/api/customers?${params.toString()}`, {
        credentials: "include",
      });
      const data = await readJson<{ customers: Customer[] }>(
        response,
        "Asiakkaiden haku epäonnistui"
      );
      writePageCache("customers", data.customers);
      setCustomers(data.customers);
      setLoadFailure(null);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setMessage(errorMessage(error, "Asiakkaiden haku epäonnistui"));
      setStatus(readPageCache("customers") ? "ready" : "error");
    }
  }, [search, showArchived]);

  useScrollRestoration("asiakkaat", status !== "loading");

  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  async function submit(payload: CustomerFormPayload) {
    setBusy(true);
    setMessage(null);
    try {
      const editing = typeof formMode === "object" ? formMode.edit : null;
      const response = await apiFetch(
        editing ? `/api/customers/${editing.id}` : "/api/customers",
        {
          method: editing ? "PATCH" : "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(editing ? {} : { "Idempotency-Key": createKey.current }),
          },
          body: JSON.stringify({
            ...payload,
            ...(editing?.updatedAt ? { expectedUpdatedAt: editing.updatedAt } : {}),
          }),
        }
      );
      await readJson(response, "Tallennus epäonnistui");
      if (!editing) createKey.current = newIdempotencyKey();
      setFormMode("hidden");
      await load();
    } catch (error) {
      if (isUnauthorized(error)) redirectToLogin();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function reloadEditing() {
    const editing = typeof formMode === "object" ? formMode.edit : null;
    if (!editing) return;
    clearDraft(`customer:${editing.id}`);
    const response = await apiFetch(`/api/customers/${editing.id}`, { credentials: "include" });
    const data = await readJson<{ customer: Customer }>(response, "Asiakkaan haku epäonnistui");
    setFormMode({ edit: { ...editing, ...data.customer } });
    setFormKey((key) => key + 1);
  }

  async function previewCsv() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/customers/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const data = await readJson<{
        rows: Array<{ line: number; name: string | null; errors: string[] }>;
      }>(response, "Tuonnin tarkistus epäonnistui");
      setCsvRows(data.rows);
    } catch (error) {
      setMessage(errorMessage(error, "Tuonnin tarkistus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function commitCsv() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/customers/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv, commit: true }),
      });
      const data = await readJson<{ created: number }>(response, "Tuonti epäonnistui");
      setMessage(`Tuotiin ${data.created} asiakasta.`);
      setImportOpen(false);
      setCsvRows(null);
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Tuonti epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function undoArchive() {
    if (!undo) return;
    const target = undo;
    setUndo(null);
    setBusy(true);
    try {
      const response = await apiFetch(`/api/customers/${target.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      await readJson(response, "Kumoaminen epäonnistui");
      setMessage(`${target.name} palautettiin.`);
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Kumoaminen epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(customer: Customer) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/customers/${customer.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const result = await readJson<{ archived: boolean; invoiceCount: number }>(
        response,
        "Poisto epäonnistui"
      );
      if (result.archived) {
        setUndo({ id: customer.id, name: customer.name });
        setMessage(null);
      } else {
        setUndo(null);
        setMessage("Asiakas poistettiin.");
      }
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

  const totalOpen = customers.reduce((sum, customer) => sum + customer.openBalance, 0);

  return (
    <>
      <div className="space-y-6 pb-6">
        <header className="space-y-2">
          <p className="text-sm text-warm-gray leading-relaxed">
            Asiakasrekisteri ja avoimet saatavat.
          </p>
        </header>

        {status === "ready" && customers.length > 0 && (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-2">
            <p className="text-sm text-warm-gray">Avoimet saatavat</p>
            <p className="text-3xl font-semibold text-charcoal tracking-tight">
              {formatEur(totalOpen)}
            </p>
            <p className="text-xs text-warm-gray">{customers.length} asiakasta</p>
          </section>
        )}

        {undo && (
          <div
            className="flex items-center justify-between gap-3 rounded-2xl bg-blush/40 px-4 py-3"
            role="status"
          >
            <p className="text-sm text-charcoal">{undo.name} arkistoitiin.</p>
            <button
              type="button"
              className="text-sm font-medium text-accent-dark underline"
              onClick={() => void undoArchive()}
            >
              Kumoa
            </button>
          </div>
        )}

        {message && (
          <p className="text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3" role="status">
            {message}
          </p>
        )}

        {formMode === "hidden" ? (
          <div className="flex flex-wrap gap-3">
            <input
              aria-label="Hae asiakasta"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Hae nimellä"
              className="min-w-0 flex-1 min-h-12 px-4 rounded-2xl border border-warm-gray-light/60 bg-white text-sm"
            />
            <Button type="button" onClick={() => setFormMode("create")}>
              Lisää
            </Button>
            <Button type="button" variant="secondary" onClick={() => setImportOpen((open) => !open)}>
              Tuo CSV
            </Button>
          </div>
        ) : (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
            <p className="text-base font-medium text-charcoal">
              {formMode === "create" ? "Uusi asiakas" : "Muokkaa asiakasta"}
            </p>
            <CustomerForm
              key={formMode === "create" ? `new-${formKey}` : formMode.edit.id + formKey}
              draftKey={formMode === "create" ? "customer:new" : `customer:${formMode.edit.id}`}
              submitLabel={formMode === "create" ? "Lisää asiakas" : "Tallenna"}
              busy={busy}
              onReload={() => void reloadEditing()}
              initial={
                typeof formMode === "object"
                  ? {
                      name: formMode.edit.name,
                      businessId: formMode.edit.businessId ?? "",
                      email: formMode.edit.email ?? "",
                      phone: formMode.edit.phone ?? "",
                      addressStreet: formMode.edit.addressStreet ?? "",
                      addressPostalCode: formMode.edit.addressPostalCode ?? "",
                      addressCity: formMode.edit.addressCity ?? "",
                      defaultPaymentTermDays: String(formMode.edit.defaultPaymentTermDays),
                      notes: formMode.edit.notes ?? "",
                    }
                  : undefined
              }
              onSubmit={submit}
              onCancel={() => setFormMode("hidden")}
            />
          </section>
        )}

        {importOpen && formMode === "hidden" && (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
            <p className="text-base font-medium text-charcoal">Tuo asiakkaita</p>
            <textarea
              aria-label="CSV-tiedosto"
              className="min-h-28 w-full rounded-2xl border border-warm-gray-light/60 bg-white p-3 text-sm"
              value={csv}
              onChange={(event) => {
                setCsv(event.target.value);
                setCsvRows(null);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void previewCsv()}>
                Tarkista
              </Button>
              <Button
                type="button"
                disabled={busy || !csvRows || csvRows.every((row) => row.errors.length > 0)}
                onClick={() => void commitCsv()}
              >
                Tuo kelvolliset
              </Button>
            </div>
            {csvRows && (
              <ul className="space-y-1 text-sm">
                {csvRows.map((row) => (
                  <li key={row.line} className={row.errors.length ? "text-danger" : "text-charcoal"}>
                    Rivi {row.line}: {row.name ?? "–"}
                    {row.errors.length > 0 ? ` — ${row.errors.join(" ")}` : " — kelvollinen"}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {status === "loading" && <LoadingState label="Haetaan asiakkaita…" />}
        {loadFailure != null && customers.length > 0 && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("customers")} onRetry={() => void load()} />
        )}
        {status === "error" && customers.length === 0 && (
          isForbidden(loadFailure) ? (
            <EmptyState kind="forbidden" />
          ) : (
            <ConnectionNotice
              error={loadFailure}
              fallback={message || "Asiakkaiden haku epäonnistui"}
              onRetry={() => void load()}
            />
          )
        )}

        {(status === "ready" || customers.length > 0) && (
          <ul className="space-y-3">
            {customers.map((customer) => (
              <li
                key={customer.id}
                className={`bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-5 space-y-3 ${
                  customer.archivedAt ? "opacity-60" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/asiakkaat/${customer.id}`}
                      className={`block text-base font-medium text-charcoal ${longNameClass}`}
                    >
                      {customer.name}
                    </Link>
                    <p className="text-xs text-warm-gray truncate">
                      {[customer.businessId, customer.email].filter(Boolean).join(" · ") ||
                        "Yksityisasiakas"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-base font-semibold text-charcoal ${amountClass}`}>
                      {formatEur(customer.openBalance)}
                    </p>
                    <p className="text-[11px] text-warm-gray">avoinna</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <span className="px-2 py-0.5 rounded-full bg-warm-gray-light/25 text-warm-gray">
                    {customer.invoiceCount} laskua
                  </span>
                  {customer.openInvoiceCount > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-danger/10 text-danger">
                      {customer.openInvoiceCount} avoinna
                    </span>
                  )}
                  <span className="px-2 py-0.5 rounded-full bg-warm-gray-light/25 text-warm-gray">
                    Maksuaika {customer.defaultPaymentTermDays} pv
                  </span>
                  {customer.lastInvoiceDate && (
                    <span className="px-2 py-0.5 rounded-full bg-warm-gray-light/25 text-warm-gray">
                      Viimeksi {formatDate(customer.lastInvoiceDate)}
                    </span>
                  )}
                  {customer.archivedAt && (
                    <span className="px-2 py-0.5 rounded-full bg-warm-gray-light/40 text-warm-gray">
                      Arkistoitu
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Link
                    href={`/laskut?customerId=${customer.id}`}
                    className="min-h-11 text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60"
                  >
                    Laskut
                  </Link>
                  <button
                    type="button"
                    onClick={() => setFormMode({ edit: customer })}
                    className="min-h-11 text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60"
                  >
                    Muokkaa
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(customer)}
                    className="min-h-11 text-xs font-medium px-3 py-2 rounded-xl border border-danger/40 text-danger"
                  >
                    Poista
                  </button>
                </div>
              </li>
            ))}

            {customers.length === 0 && (
              <EmptyState
                kind={search || showArchived ? "filtered" : "records"}
                title={search || showArchived ? "Ei osumia" : "Ei asiakkaita vielä"}
                body={
                  search || showArchived
                    ? "Yksikään asiakas ei vastaa hakua."
                    : "Lisää ensimmäinen asiakas, niin laskutus löytää sen."
                }
                onCreate={formMode === "hidden" ? () => setFormMode("create") : undefined}
                createLabel="Lisää asiakas"
                onClear={() => {
                  setSearch("");
                  setShowArchived(false);
                }}
              />
            )}
          </ul>
        )}

        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived ? "Piilota arkistoidut" : "Näytä arkistoidut"}
        </Button>
      </div>

      <ConfirmModal
        isOpen={confirmRemove !== null}
        title="Poistetaanko asiakas?"
        description={
          confirmRemove
            ? `${confirmRemove.name}${
                confirmRemove.invoiceCount > 0
                  ? ` – asiakkaalla on ${confirmRemove.invoiceCount} laskua, joten se arkistoidaan poiston sijaan.`
                  : ""
              }`
            : ""
        }
        confirmLabel="Poista"
        onConfirm={() => (confirmRemove ? remove(confirmRemove) : Promise.resolve())}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
