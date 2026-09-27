"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  apiFetch,
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { formatDate, formatEur } from "@/lib/format";
import { Button, controlClass } from "@/components/ui";

interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    businessId: string | null;
    contactPerson: string | null;
    email: string | null;
    phone: string | null;
    addressStreet: string | null;
    addressPostalCode: string | null;
    addressCity: string | null;
    notes: string | null;
    archivedAt: string | null;
  };
  openBalance: number;
  openInvoiceCount: number;
  lastPayment: { paidDate: string; amount: number; invoiceNumber: number } | null;
  invoices: Array<{
    id: string;
    number: number;
    displayStatus: string;
    issueDate: string;
    gross: number;
    open: number;
  }>;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Luonnos",
  sent: "Lähetetty",
  overdue: "Myöhässä",
  paid: "Maksettu",
  credited: "Hyvitetty",
};

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [others, setOthers] = useState<Array<{ id: string; name: string }>>([]);
  const [mergeId, setMergeId] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [response, list] = await Promise.all([
        apiFetch(`/api/customers/${id}`, { credentials: "include" }),
        apiFetch("/api/customers?includeArchived=1", { credentials: "include" }),
      ]);
      const data = await readJson<CustomerDetail>(response, "Asiakkaan haku epäonnistui");
      const listed = await readJson<{ customers: Array<{ id: string; name: string }> }>(
        list,
        "Asiakkaiden haku epäonnistui"
      );
      setDetail(data);
      setOthers(listed.customers.filter((customer) => customer.id !== id));
      setState("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setMessage(errorMessage(error, "Asiakkaan haku epäonnistui"));
      setState("error");
    }
  }, [id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function merge() {
    if (!mergeId) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/customers/merge", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId: id, mergeId }),
      });
      await readJson(response, "Yhdistäminen epäonnistui");
      setMessage("Asiakkaat yhdistettiin. Kaksoiskappale arkistoitiin.");
      setMergeId("");
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Yhdistäminen epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  const customer = detail?.customer;
  const address = [customer?.addressStreet, customer?.addressPostalCode, customer?.addressCity]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-6 pb-6">
      {state === "loading" && <LoadingState label="Haetaan asiakasta…" />}
      {state === "error" && (
        <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
      )}
      {state === "ready" && detail && customer && (
        <>
          <header className="select-text space-y-1">
            <h2 className="text-2xl font-semibold text-charcoal tracking-tight">{customer.name}</h2>
            <p className="text-sm text-warm-gray">
              {customer.businessId || "Yksityisasiakas"}
              {customer.archivedAt ? " · arkistoitu" : ""}
            </p>
          </header>

          {message && (
            <p className="text-sm text-charcoal bg-blush/40 rounded-2xl px-4 py-3" role="status">
              {message}
            </p>
          )}

          <section className="select-text bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-2 text-sm">
            <p className="text-base font-medium text-charcoal">Yhteystiedot</p>
            <p className="text-charcoal">{customer.contactPerson || "Ei yhteyshenkilöä"}</p>
            <p className="text-warm-gray">{customer.email || "Ei sähköpostia"}</p>
            <p className="text-warm-gray">{customer.phone || "Ei puhelinta"}</p>
            <p className="text-warm-gray">{address || "Ei osoitetta"}</p>
            {customer.notes && <p className="text-warm-gray">{customer.notes}</p>}
          </section>

          <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-warm-gray">Avoinna</span>
              <span className="font-semibold text-charcoal">{formatEur(detail.openBalance)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-warm-gray">Avoimia laskuja</span>
              <span className="text-charcoal">{detail.openInvoiceCount}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-warm-gray">Viimeisin maksu</span>
              <span className="text-charcoal">
                {detail.lastPayment
                  ? `${formatEur(detail.lastPayment.amount)} · lasku ${detail.lastPayment.invoiceNumber}`
                  : "–"}
              </span>
            </div>
          </section>

          <section className="space-y-3">
            <p className="text-base font-medium text-charcoal">Laskut</p>
            {detail.invoices.length === 0 ? (
              <p className="text-sm text-warm-gray">Ei laskuja.</p>
            ) : (
              <ul className="space-y-2">
                {detail.invoices.map((invoice) => (
                  <li key={invoice.id}>
                    <Link
                      href={`/laskut/${invoice.id}`}
                      className="flex items-center justify-between gap-3 rounded-2xl bg-white border border-warm-gray-light/20 px-4 py-3 text-sm"
                    >
                      <span className="text-charcoal">
                        {invoice.number} · {STATUS_LABEL[invoice.displayStatus] ?? invoice.displayStatus}
                      </span>
                      <span className="text-warm-gray">
                        {formatDate(invoice.issueDate)} · {formatEur(invoice.open)} avoinna
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {others.length > 0 && (
            <section className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-3">
              <p className="text-base font-medium text-charcoal">Yhdistä kaksoiskappale</p>
              <p className="text-sm text-warm-gray">
                Laskut ja toistuvat laskut siirtyvät tälle asiakkaalle. Toinen asiakas arkistoidaan.
              </p>
              <select
                aria-label="Yhdistettävä asiakas"
                className={`${controlClass} min-h-12 w-full`}
                value={mergeId}
                onChange={(event) => setMergeId(event.target.value)}
              >
                <option value="">Valitse asiakas</option>
                {others.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.name}
                  </option>
                ))}
              </select>
              <Button type="button" disabled={busy || !mergeId} onClick={() => void merge()}>
                Yhdistä tähän
              </Button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
