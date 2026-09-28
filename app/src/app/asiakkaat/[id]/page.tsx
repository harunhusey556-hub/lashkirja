"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
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
import { Button, buttonClass, controlClass } from "@/components/ui";
import { BottomActions, DetailHero, KeyValueList, ListRow, MoreMenu, Section, StatusTag } from "@/components/ds";
import { SALES_STATUS } from "@/lib/status-labels";
import { clearDraft } from "@/lib/draft-store";

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
    defaultPaymentTermDays: number;
    notes: string | null;
    archivedAt: string | null;
    updatedAt: string;
  };
  openBalance: number;
  openInvoiceCount: number;
  invoicedTotal: number;
  lastPayment: { paidDate: string; amount: number; invoiceNumber: number } | null;
  invoices: Array<{
    id: string;
    number: number;
    displayStatus: "draft" | "sent" | "overdue" | "paid" | "credited";
    issueDate: string;
    gross: number;
    open: number;
  }>;
}

/** Left for /asiakkaat to show once, after a hard delete navigates away from here. */
const FLASH_KEY = "asiakkaat:flash";

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [others, setOthers] = useState<Array<{ id: string; name: string }>>([]);
  const [mergeId, setMergeId] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState(0);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  async function submitEdit(payload: CustomerFormPayload) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/customers/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          ...(detail?.customer.updatedAt ? { expectedUpdatedAt: detail.customer.updatedAt } : {}),
        }),
      });
      await readJson(response, "Tallennus epäonnistui");
      setEditOpen(false);
      await load();
    } catch (error) {
      if (isUnauthorized(error)) redirectToLogin();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function reloadEditing() {
    clearDraft(`customer:${id}`);
    await load();
    setEditKey((key) => key + 1);
  }

  async function restore() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/api/customers/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      await readJson(response, "Palautus epäonnistui");
      setMessage("Asiakas palautettiin arkistosta.");
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Palautus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/customers/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const result = await readJson<{ archived: boolean; invoiceCount: number }>(
        response,
        "Poisto epäonnistui"
      );
      setConfirmRemove(false);
      if (result.archived) {
        setMessage("Asiakas arkistoitiin. Sen voi palauttaa Lisää toimintoja -valikosta.");
        await load();
      } else {
        try {
          window.sessionStorage.setItem(FLASH_KEY, "Asiakas poistettiin.");
        } catch {
          // Best-effort only; the delete itself already succeeded.
        }
        router.push("/asiakkaat");
      }
    } catch (error) {
      // Thrown, not also set as the page-level message: the ConfirmModal is
      // still open and already renders this text itself (settleConfirm),
      // right behind the buttons - setting the page message too would show
      // the exact same sentence twice, once inside the dialog and once in
      // the (backdrop-hidden, so pointless anyway) page banner behind it.
      throw new Error(errorMessage(error, "Poisto epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function merge() {
    if (!mergeId) return;
    setBusy(true);
    setMergeError("");
    try {
      const response = await apiFetch("/api/customers/merge", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId: id, mergeId }),
      });
      await readJson(response, "Yhdistäminen epäonnistui");
      setMergeId("");
      setMergeOpen(false);
      setMessage("Asiakkaat yhdistettiin. Kaksoiskappale arkistoitiin.");
      await load();
    } catch (error) {
      // Renders inside the "Yhdistä kaksoiskappale" sheet, which stays open,
      // not the page-level message behind it.
      setMergeError(errorMessage(error, "Yhdistäminen epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  const customer = detail?.customer;
  const address = [customer?.addressStreet, customer?.addressPostalCode, customer?.addressCity]
    .filter(Boolean)
    .join(", ");
  const archived = Boolean(customer?.archivedAt);

  const menuItems = customer
    ? [
        { label: "Muokkaa", onSelect: () => setEditOpen(true) },
        ...(others.length > 0
          ? [{ label: "Yhdistä kaksoiskappale", onSelect: () => setMergeOpen(true) }]
          : []),
        archived
          ? { label: "Palauta arkistosta", onSelect: () => void restore(), disabled: busy }
          : {
              label: "Poista",
              onSelect: () => setConfirmRemove(true),
              tone: "danger" as const,
              disabled: busy,
            },
      ]
    : [];

  return (
    <>
      <div className="space-y-6 pb-6">
        {state === "loading" && <LoadingState label="Haetaan asiakasta…" />}
        {state === "error" && (
          <ErrorState message={message || "Haku epäonnistui"} onRetry={() => void load()} />
        )}

        {state === "ready" && detail && customer && (
          <>
            <DetailHero
              amount={formatEur(detail.openBalance)}
              title={customer.name}
              meta={customer.businessId || "Yksityisasiakas"}
              status={archived ? <StatusTag tone="neutral">Arkistoitu</StatusTag> : undefined}
              menu={<MoreMenu items={menuItems} />}
            />

            {message && (
              <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
                {message}
              </p>
            )}

            <KeyValueList
              rows={[
                { label: "Yhteyshenkilö", value: customer.contactPerson || "Ei yhteyshenkilöä" },
                { label: "Sähköposti", value: customer.email || "Ei sähköpostia" },
                { label: "Puhelin", value: customer.phone || "Ei puhelinta" },
                { label: "Osoite", value: address || "Ei osoitetta" },
                ...(customer.notes ? [{ label: "Muistiinpanot", value: customer.notes }] : []),
                { label: "Maksuaika", value: `${customer.defaultPaymentTermDays} pv` },
                { label: "Avoimia laskuja", value: String(detail.openInvoiceCount) },
                { label: "Laskutettu yhteensä", value: formatEur(detail.invoicedTotal) },
                ...(detail.lastPayment
                  ? [
                      {
                        label: "Viimeisin maksu",
                        value: `${formatEur(detail.lastPayment.amount)} · lasku ${detail.lastPayment.invoiceNumber}`,
                      },
                    ]
                  : []),
              ]}
            />

            <Section
              title="Laskut"
              action={
                <Link
                  href={`/laskut?customerId=${customer.id}`}
                  className="inline-flex min-h-11 items-center text-[13px] font-semibold text-accent"
                >
                  Näytä kaikki
                </Link>
              }
            >
              {detail.invoices.length === 0 ? (
                <p className="px-4 py-4 text-[15px] text-ink-2">Ei laskuja.</p>
              ) : (
                detail.invoices.map((invoice) => (
                  <ListRow
                    key={invoice.id}
                    href={`/laskut/${invoice.id}`}
                    title={`Lasku ${invoice.number}`}
                    amount={formatEur(invoice.gross)}
                    secondary={
                      invoice.open > 0
                        ? `${formatDate(invoice.issueDate)} · ${formatEur(invoice.open)} avoinna`
                        : formatDate(invoice.issueDate)
                    }
                    trailing={
                      <StatusTag tone={SALES_STATUS[invoice.displayStatus].tone}>
                        {SALES_STATUS[invoice.displayStatus].label}
                      </StatusTag>
                    }
                  />
                ))
              )}
            </Section>
          </>
        )}
      </div>

      {state === "ready" && customer && !archived && (
        <BottomActions>
          <Link href={`/laskut/uusi?customerId=${customer.id}`} className={buttonClass("primary", "w-full")}>
            Uusi lasku tälle asiakkaalle
          </Link>
        </BottomActions>
      )}

      <BottomSheet
        isOpen={editOpen}
        onClose={() => setEditOpen(false)}
        title="Muokkaa asiakasta"
        labelledBy="customer-edit-title"
        heightClass="max-h-[92dvh]"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sheet-safe-bottom">
          {customer && (
            <CustomerForm
              key={customer.id + editKey}
              draftKey={`customer:${customer.id}`}
              submitLabel="Tallenna"
              busy={busy}
              onReload={() => void reloadEditing()}
              initial={{
                name: customer.name,
                businessId: customer.businessId ?? "",
                contactPerson: customer.contactPerson ?? "",
                email: customer.email ?? "",
                phone: customer.phone ?? "",
                addressStreet: customer.addressStreet ?? "",
                addressPostalCode: customer.addressPostalCode ?? "",
                addressCity: customer.addressCity ?? "",
                defaultPaymentTermDays: String(customer.defaultPaymentTermDays),
                notes: customer.notes ?? "",
              }}
              onSubmit={submitEdit}
              onCancel={() => setEditOpen(false)}
            />
          )}
        </div>
      </BottomSheet>

      <BottomSheet
        isOpen={mergeOpen}
        onClose={() => {
          setMergeOpen(false);
          setMergeError("");
        }}
        title="Yhdistä kaksoiskappale"
        labelledBy="customer-merge-title"
      >
        <div className="space-y-3 px-5 py-4 sheet-safe-bottom">
          <p className="text-[13px] text-ink-2">
            Laskut ja toistuvat laskut siirtyvät tälle asiakkaalle. Toinen asiakas arkistoidaan.
          </p>
          <select
            aria-label="Yhdistettävä asiakas"
            className={`${controlClass} min-h-12`}
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
          {mergeError && (
            <p className="text-sm text-danger" role="alert">
              {mergeError}
            </p>
          )}
          <Button type="button" className="w-full" disabled={busy || !mergeId} onClick={() => void merge()}>
            Yhdistä tähän
          </Button>
        </div>
      </BottomSheet>

      <ConfirmModal
        isOpen={confirmRemove}
        title="Poistetaanko asiakas?"
        description={
          customer
            ? detail && detail.invoices.length > 0
              ? `${customer.name}. Asiakkaalla on ${detail.invoices.length} laskua, joten se arkistoidaan poiston sijaan.`
              : customer.name
            : ""
        }
        confirmLabel="Poista"
        onConfirm={() => remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}
