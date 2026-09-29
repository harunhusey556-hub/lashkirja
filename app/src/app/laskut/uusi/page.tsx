"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LoadingState } from "@/components/AsyncState";
import { InvoiceForm, type InvoicePayload } from "@/components/invoices/InvoiceForm";
import {
  apiFetch,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { armNavigation } from "@/lib/nav-direction";
import { DETAIL_ROUTES, detailHref } from "@/lib/routes";
import { PageTitle } from "@/components/ds";

interface CustomerOption {
  id: string;
  name: string;
  defaultPaymentTermDays: number;
}

export default function NewInvoiceRoute() {
  return (
    <Suspense fallback={<LoadingState label="Haetaan asiakkaita…" />}>
      <NewInvoicePage />
    </Suspense>
  );
}

function NewInvoicePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customerId") ?? "";
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const createKey = useRef(newIdempotencyKey());

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/customers", { credentials: "include" })
      .then((response) => readJson<{ customers: CustomerOption[] }>(response, ""))
      .then((data) => {
        if (!cancelled) setCustomers(data.customers ?? []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setCustomers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function leave() {
    armNavigation("/laskut", "back");
    router.push("/laskut");
  }

  async function createInvoice(payload: InvoicePayload) {
    setBusy(true);
    try {
      const response = await apiFetch("/api/invoices", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": createKey.current,
        },
        body: JSON.stringify(payload),
      });
      const data = await readJson<{ invoice: { id: string } }>(response, "Laskun luonti epäonnistui");
      createKey.current = newIdempotencyKey();
      // armNavigation keys off the pathname the shell later reads with
      // usePathname(), which never includes the query string, so it arms
      // the bare detail path here while the actual navigation carries ?id=.
      armNavigation(DETAIL_ROUTES.invoice, "back");
      router.replace(detailHref("invoice", data.invoice.id));
    } catch (error) {
      if (isUnauthorized(error)) redirectToLogin();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  if (!customers) return <LoadingState label="Haetaan asiakkaita…" />;

  return (
    <div className="space-y-6">
      <PageTitle title="Uusi lasku" subtitle="Luonnos tallentuu tälle laitteelle, kunnes lähetät laskun." />
      {customers.length === 0 ? (
        <p className="px-1 text-[15px] text-ink-2">
          Lisää ensin asiakas{" "}
          <Link className="text-accent" href="/asiakkaat">
            Asiakkaat
          </Link>
          -sivulla.
        </p>
      ) : (
        <InvoiceForm
          customers={customers}
          submitLabel="Luo lasku"
          busy={busy}
          draftKey="invoice:new"
          initial={customerId ? { customerId } : undefined}
          onSubmit={createInvoice}
          onCancel={leave}
        />
      )}
    </div>
  );
}
