"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { ErrorState, LoadingState } from "@/components/AsyncState";
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
  invoiceCount: number;
  openInvoiceCount: number;
  openBalance: number;
  invoicedTotal: number;
  lastInvoiceDate: string | null;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [formMode, setFormMode] = useState<"hidden" | "create" | { edit: Customer }>("hidden");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Customer | null>(null);

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
      setCustomers(data.customers);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setMessage(errorMessage(error, "Asiakkaiden haku epäonnistui"));
      setStatus("error");
    }
  }, [search, showArchived]);

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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      await readJson(response, "Tallennus epäonnistui");
      setFormMode("hidden");
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Tallennus epäonnistui"));
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
      setMessage(
        result.archived
          ? `Asiakkaalla on ${result.invoiceCount} laskua, joten se arkistoitiin poiston sijaan.`
          : "Asiakas poistettiin."
      );
      setConfirmRemove(null);
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Poisto epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  const totalOpen = customers.reduce((sum, customer) => sum + customer.openBalance, 0);

  return (
    <AppShell>
      <div className="space-y-6 pb-6">
        <header className="space-y-2">
          <h2 className="text-2xl font-semibold text-charcoal tracking-tight">Asiakkaat</h2>
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

        {message && (
          <p className="text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3" role="status">
            {message}
          </p>
        )}

        {formMode === "hidden" ? (
          <div className="flex gap-3">
            <input
              aria-label="Hae asiakasta"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Hae nimellä"
              className="flex-1 px-4 py-3 rounded-2xl border border-warm-gray-light/60 bg-white text-sm"
            />
            <button
              type="button"
              onClick={() => setFormMode("create")}
              className="px-5 py-3 rounded-2xl bg-accent text-white text-sm font-medium hover:bg-accent-dark"
            >
              Lisää
            </button>
          </div>
        ) : (
          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
            <p className="text-base font-medium text-charcoal">
              {formMode === "create" ? "Uusi asiakas" : "Muokkaa asiakasta"}
            </p>
            <CustomerForm
              submitLabel={formMode === "create" ? "Lisää asiakas" : "Tallenna"}
              busy={busy}
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

        {status === "loading" && <LoadingState label="Haetaan asiakkaita…" />}
        {status === "error" && (
          <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
        )}

        {status === "ready" && (
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
                    <p className="text-base font-medium text-charcoal truncate">{customer.name}</p>
                    <p className="text-xs text-warm-gray truncate">
                      {[customer.businessId, customer.email].filter(Boolean).join(" · ") ||
                        "Yksityisasiakas"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-base font-semibold text-charcoal">
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
                    className="text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60"
                  >
                    Laskut
                  </Link>
                  <button
                    type="button"
                    onClick={() => setFormMode({ edit: customer })}
                    className="text-xs font-medium px-3 py-2 rounded-xl border border-warm-gray-light/60"
                  >
                    Muokkaa
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(customer)}
                    className="text-xs font-medium px-3 py-2 rounded-xl border border-danger/40 text-danger"
                  >
                    Poista
                  </button>
                </div>
              </li>
            ))}

            {customers.length === 0 && (
              <p className="text-sm text-warm-gray text-center py-8">
                {search ? "Ei osumia." : "Ei vielä asiakkaita."}
              </p>
            )}
          </ul>
        )}

        <button
          type="button"
          onClick={() => setShowArchived((value) => !value)}
          className="w-full text-xs text-warm-gray py-2"
        >
          {showArchived ? "Piilota arkistoidut" : "Näytä arkistoidut"}
        </button>
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
        onConfirm={() => confirmRemove && void remove(confirmRemove)}
        onCancel={() => setConfirmRemove(null)}
      />
    </AppShell>
  );
}
