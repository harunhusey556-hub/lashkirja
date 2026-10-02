"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  InvoiceForm,
  type InvoiceFormValues,
  type InvoicePayload,
} from "@/components/invoices/InvoiceForm";
import { QuickCustomerSheet, type CreatedCustomer } from "@/components/invoices/QuickCustomerSheet";
import { useProfile } from "@/app/asetukset/useProfile";
import {
  apiFetch,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";
import { ConnectionNotice, EmptyState } from "@/components/ScreenState";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { sellerPreflight } from "@/lib/invoice-preflight";
import { armNavigation } from "@/lib/nav-direction";
import { DETAIL_ROUTES, detailHref } from "@/lib/routes";
import { writePageCache } from "@/lib/page-cache";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";
import { PageTitle, Skeleton, SkeletonCard, SkeletonGroup } from "@/components/ds";

interface CustomerOption {
  id: string;
  name: string;
  defaultPaymentTermDays: number;
}

/** The draft invoice being edited (the fields the form needs, plus the version). */
interface EditableInvoice {
  id: string;
  status: string;
  updatedAt: string;
  customer: { id: string };
  issueDate: string;
  dueDate: string;
  notes: string | null;
  lines: Array<{ description: string; quantity: number; unit: string; unitPrice: number; vatRate: number }>;
}

function decimalText(value: number, fixed?: number): string {
  return (fixed === undefined ? String(value) : value.toFixed(fixed)).replace(".", ",");
}

function toFormValues(invoice: EditableInvoice): Partial<InvoiceFormValues> {
  return {
    customerId: invoice.customer.id,
    issueDate: invoice.issueDate.slice(0, 10),
    dueDate: invoice.dueDate.slice(0, 10),
    notes: invoice.notes ?? "",
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: decimalText(line.quantity),
      unit: line.unit,
      unitPrice: decimalText(line.unitPrice, 2),
      vatRate: line.vatRate,
    })),
  };
}

/** The form at its final layout while customers (and an edited invoice) load. */
function FormSkeleton() {
  return (
    <SkeletonGroup label="Ladataan lomaketta" className="space-y-6">
      <SkeletonCard className="space-y-4">
        <Skeleton className="h-3 w-16" />
        <Skeleton radius="card" className="h-11 w-full" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton radius="card" className="h-11" />
          <Skeleton radius="card" className="h-11" />
        </div>
      </SkeletonCard>
      <SkeletonCard className="space-y-3">
        <Skeleton className="h-3 w-14" />
        <Skeleton radius="card" className="h-11 w-full" />
        <div className="grid grid-cols-3 gap-2">
          <Skeleton radius="card" className="h-11" />
          <Skeleton radius="card" className="h-11" />
          <Skeleton radius="card" className="h-11" />
        </div>
      </SkeletonCard>
    </SkeletonGroup>
  );
}

export default function NewInvoiceRoute() {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <NewInvoicePage />
    </Suspense>
  );
}

function NewInvoicePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const customerId = searchParams.get("customerId") ?? "";
  const editId = searchParams.get("edit") ?? "";
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [editing, setEditing] = useState<EditableInvoice | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [justCreated, setJustCreated] = useState<string | undefined>(undefined);
  const createKey = useRef(newIdempotencyKey());
  // The seller's VAT status decides the ALV choice, so the form waits for it
  // (it is cached, so this is instant after the first visit).
  const { profile, loadError: profileError, retry: retryProfile } = useProfile();

  useEffect(() => {
    let cancelled = false;
    // A failed load is an error with a retry, never "add a customer first"
    // (SALES-09): the customers may well exist.
    const jobs: Promise<unknown>[] = [
      apiFetch("/api/customers", { credentials: "include" })
        .then((response) => readJson<{ customers: CustomerOption[] }>(response, "Asiakkaiden haku epäonnistui"))
        .then((data) => {
          if (!cancelled) setCustomers(data.customers ?? []);
        }),
    ];
    if (editId) {
      jobs.push(
        apiFetch(`/api/invoices/${editId}`, { credentials: "include" })
          .then((response) => readJson<{ invoice: EditableInvoice }>(response, "Laskun haku epäonnistui"))
          .then((data) => {
            if (!cancelled) setEditing(data.invoice);
          })
      );
    }
    Promise.all(jobs)
      .then(() => {
        if (!cancelled) setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [editId, attempt]);

  const leave = useCallback(() => {
    const target = editId ? detailHref("invoice", editId) : "/laskut";
    armNavigation(editId ? DETAIL_ROUTES.invoice : "/laskut", "back");
    router.push(target);
  }, [editId, router]);

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
      void hapticNotify("success");
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

  async function saveEdit(payload: InvoicePayload) {
    if (!editing) return;
    setBusy(true);
    try {
      // expectedUpdatedAt: an edit made elsewhere in the meantime is a
      // conflict with a clear message, never a silent overwrite.
      const response = await apiFetch(`/api/invoices/${editing.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, expectedUpdatedAt: editing.updatedAt }),
      });
      const data = await readJson<{ invoice: { id: string } }>(response, "Muutosten tallennus epäonnistui");
      writePageCache(`invoice:${editing.id}`, data.invoice);
      // The success toast gives the haptic (ToastHost); no second one here.
      showToast({ tone: "success", text: "Muutokset tallennettiin" });
      armNavigation(DETAIL_ROUTES.invoice, "back");
      router.replace(detailHref("invoice", editing.id));
    } catch (error) {
      if (isUnauthorized(error)) redirectToLogin();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function onCustomerCreated(customer: CreatedCustomer) {
    setCustomers((current) => [...(current ?? []), customer].sort((a, b) => a.name.localeCompare(b.name, "fi")));
    setJustCreated(customer.id);
  }

  const title = editId ? "Muokkaa laskua" : "Uusi lasku";
  const ready =
    customers !== null && (!editId || editing !== null) && profile !== null;
  // Without the profile the form cannot know whether to offer an ALV choice: ask again instead of guessing.
  const profileFailed = profile === null && Boolean(profileError);
  // F22: a new invoice says what its send will need, before the invoice exists. Non-blocking: drafts can be made.
  const sellerNote = editId ? null : sellerPreflight(profile);

  return (
    <div className="space-y-6">
      {/* R4: no subtitle on a form page. */}
      <PageTitle title={title} />
      {ready && sellerNote ? (
        <div className="rounded-card border border-warning/30 bg-warning/10 p-4 text-body text-ink" role="note">
          <p className="font-semibold">{sellerNote.title}</p>
          <p className="mt-0.5 text-caption text-ink-2">{sellerNote.body}</p>
          <Link
            href="/asetukset/laskutus"
            prefetch={true}
            className="relative mt-1 inline-block font-medium text-accent before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']"
          >
            Täydennä tiedot
          </Link>
        </div>
      ) : null}
      {loadError != null && !ready ? (
        <ConnectionNotice
          error={loadError}
          fallback={editId ? "Laskun haku epäonnistui" : "Asiakkaiden haku epäonnistui"}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : profileFailed ? (
        <ConnectionNotice
          error={profileError}
          fallback="Yrityksen tietojen haku epäonnistui"
          onRetry={retryProfile}
        />
      ) : !ready ? (
        <FormSkeleton />
      ) : editing && editing.status !== "draft" ? (
        <EmptyState
          kind="records"
          title="Laskua ei voi enää muokata"
          body="Vain luonnosta voi muokata. Lähetetty lasku korjataan hyvityslaskulla."
          onCreate={leave}
          createLabel="Takaisin laskuun"
        />
      ) : customers.length === 0 ? (
        <EmptyState
          kind="records"
          title="Lisää ensin asiakas"
          body="Laskulle tarvitaan asiakas. Voit lisätä sen tästä, ja se valitaan laskulle."
          onCreate={() => setAddOpen(true)}
          createLabel="Lisää asiakas"
        />
      ) : (
        <InvoiceForm
          key={editing ? `edit-${editing.id}` : "new"}
          customers={customers}
          submitLabel={editing ? "Tallenna muutokset" : "Luo lasku"}
          busy={busy}
          draftKey={editing ? `invoice:edit:${editing.id}` : "invoice:new"}
          vatRegistered={profile?.vatRegistered ?? true}
          initial={
            editing
              ? toFormValues(editing)
              : customerId || justCreated
                ? { customerId: customerId || justCreated }
                : undefined
          }
          onAddCustomer={() => setAddOpen(true)}
          selectCustomerId={justCreated}
          onSubmit={editing ? saveEdit : createInvoice}
          onCancel={leave}
        />
      )}

      <QuickCustomerSheet
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={onCustomerCreated}
      />
    </div>
  );
}
