"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
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
import {
  BottomActions,
  DetailHero,
  KeyValueList,
  ListRow,
  MoreMenu,
  Section,
  Skeleton,
  SkeletonCard,
  SkeletonGroup,
  StatusTag,
  useSkeletonFade,
} from "@/components/ds";
import { SALES_STATUS } from "@/lib/status-labels";
import { clearDraft } from "@/lib/draft-store";
import { detailHref } from "@/lib/routes";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";

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

/** Hero plus the contact card at their final sizes (L1, SALES-19). */
function CustomerSkeleton() {
  return (
    <SkeletonGroup label="Ladataan asiakasta" className="space-y-6">
      <div className="flex flex-col items-center px-2 pb-5 pt-2">
        <Skeleton className="h-10 w-36" />
        <Skeleton className="mt-3 h-4 w-40" />
        <Skeleton tone="soft" className="mt-2 h-3.5 w-28" />
      </div>
      <SkeletonCard className="space-y-4">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex justify-between gap-6">
            <Skeleton tone="soft" className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ))}
      </SkeletonCard>
    </SkeletonGroup>
  );
}

/** A contact value the phone can act on: call, write, or open in Maps (SALES-30). */
function ContactLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="relative break-all text-accent before:absolute before:-inset-y-[12px] before:inset-x-0 before:content-['']"
    >
      {children}
    </a>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<CustomerSkeleton />}>
      <CustomerDetail />
    </Suspense>
  );
}

function CustomerDetail() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();

  const cacheKey = id ? `customer:${id}` : "";
  const cachedDetail = id ? readPageCache<CustomerDetail>(cacheKey) : null;
  const [detail, setDetail] = useState<CustomerDetail | null>(cachedDetail);
  const [others, setOthers] = useState<Array<{ id: string; name: string }>>([]);
  const [mergeId, setMergeId] = useState("");
  // Task 7-style instant paint: a cached copy renders immediately while
  // `load()` (below) confirms or refreshes it in the background.
  const [state, setState] = useState<"loading" | "ready" | "error">(cachedDetail ? "ready" : "loading");
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton.
  const lateDetail = useCacheAfterBoot<CustomerDetail>(cacheKey || null);
  const [appliedLateDetail, setAppliedLateDetail] = useState<CustomerDetail | null>(null);
  if (lateDetail && lateDetail !== appliedLateDetail && state === "loading") {
    setAppliedLateDetail(lateDetail);
    setDetail(lateDetail);
    setState("ready");
  }
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState(0);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setMessage("Asiakasta ei löytynyt.");
      setState("error");
      return;
    }
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
      setRefreshFailed(false);
      setLoadFailure(null);
      writePageCache(`customer:${id}`, data);
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      // A cached copy already on screen (readPageCache above, or an earlier
      // successful load) stays up rather than being replaced by the error
      // screen -- only a customer never seen before goes to "error".
      setLoadFailure(error);
      if (readPageCache<CustomerDetail>(`customer:${id}`)) {
        // Still shown, but marked as the saved copy with a retry (SALES-28).
        setRefreshFailed(true);
        return;
      }
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

  const fade = useSkeletonFade(state === "loading");
  const menuItems = customer
    ? [
        { label: "Muokkaa", onSelect: () => setEditOpen(true) },
        // AX-07, R25: the Y-tunnus can be copied.
        ...(customer.businessId
          ? [{ label: "Kopioi Y-tunnus", onSelect: () => void copyToClipboard(customer.businessId ?? "", "Y-tunnus") }]
          : []),
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
      <div className="space-y-6">
        {state === "loading" && <CustomerSkeleton />}
        {state === "error" && (
          <ConnectionNotice
            error={loadFailure}
            fallback={id ? "Asiakkaan haku epäonnistui" : "Asiakasta ei löytynyt."}
            onRetry={() => {
              setState("loading");
              void load();
            }}
          />
        )}

        {state === "ready" && detail && customer && (
          <div className={`space-y-6 ${fade}`}>
            {refreshFailed && (
              <StaleBanner fetchedAt={pageCacheFetchedAt(`customer:${id}`)} onRetry={() => void load()} />
            )}
            <DetailHero
              amount={formatEur(detail.openBalance)}
              title={customer.name}
              meta={`Avoinna · ${customer.businessId || "Yksityisasiakas"}`}
              status={archived ? <StatusTag tone="neutral">Arkistoitu</StatusTag> : undefined}
              menu={<MoreMenu items={menuItems} />}
            />

            {message && (
              <p className="rounded-card bg-accent-soft px-4 py-3 text-caption text-ink" role="status">
                {message}
              </p>
            )}

            <KeyValueList
              rows={[
                { label: "Yhteyshenkilö", value: customer.contactPerson || "Ei yhteyshenkilöä" },
                {
                  label: "Sähköposti",
                  value: customer.email ? (
                    <ContactLink href={`mailto:${customer.email}`}>{customer.email}</ContactLink>
                  ) : (
                    "Ei sähköpostia"
                  ),
                },
                {
                  label: "Puhelin",
                  value: customer.phone ? (
                    <ContactLink href={`tel:${customer.phone.replace(/[^\d+]/g, "")}`}>{customer.phone}</ContactLink>
                  ) : (
                    "Ei puhelinta"
                  ),
                },
                {
                  label: "Osoite",
                  value: address ? (
                    <ContactLink href={`https://maps.apple.com/?q=${encodeURIComponent(address)}`}>
                      {address}
                    </ContactLink>
                  ) : (
                    "Ei osoitetta"
                  ),
                },
                ...(customer.notes ? [{ label: "Muistiinpanot", value: customer.notes }] : []),
                ...(customer.businessId
                  ? [{ label: "Y-tunnus", value: customer.businessId, copy: { text: customer.businessId, what: "Y-tunnus" } }]
                  : []),
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
                  className="inline-flex min-h-11 items-center text-caption font-semibold text-accent"
                >
                  Näytä kaikki
                </Link>
              }
            >
              {detail.invoices.length === 0 ? (
                <p className="px-4 py-4 text-body text-ink-2">Ei laskuja.</p>
              ) : (
                detail.invoices.map((invoice) => (
                  <ListRow
                    key={invoice.id}
                    href={detailHref("invoice", invoice.id)}
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
          </div>
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
              onSaved={() => setEditOpen(false)}
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
          <p className="text-caption text-ink-2">
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
            <p className="text-caption text-danger" role="alert">
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
