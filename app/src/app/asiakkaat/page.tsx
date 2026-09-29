"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState, StaleBanner } from "@/components/ScreenState";
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
import { formatEur } from "@/lib/format";
import { Plus } from "lucide-react";
import { Card, Icon, ListRow, PageTitle, Section, StatusTag, SummaryCard } from "@/components/ds";

import { Button, buttonClass, controlClass } from "@/components/ui";
import { showToast } from "@/lib/toast";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { readTextFile } from "@/components/invoices/decodeText";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { isForbidden } from "@/lib/screen-state";
import { detailHref } from "@/lib/routes";

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

/**
 * Read once by this page after a redirect from the customer detail page. Only
 * a hard delete (no invoices on the customer) navigates back here - an
 * archive stays on the detail page and shows its own message there instead
 * (see asiakkaat/asiakas/page.tsx).
 */
const FLASH_KEY = "asiakkaat:flash";

/** "Y-tunnus · Maksuaika N pv" (private customers have no Y-tunnus). */
function rowSecondary(customer: Customer): string {
  const term = `Maksuaika ${customer.defaultPaymentTermDays} pv`;
  return customer.businessId ? `${customer.businessId} · ${term}` : `Yksityisasiakas · ${term}`;
}

export default function CustomersPage() {
  const cached = readPageCache<Customer[]>("customers");
  const [customers, setCustomers] = useState<Customer[]>(cached ?? []);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton.
  const lateCache = useCacheAfterBoot<Customer[]>("customers");
  const [appliedLateCache, setAppliedLateCache] = useState<Customer[] | null>(null);
  if (lateCache && lateCache !== appliedLateCache && status === "loading") {
    setAppliedLateCache(lateCache);
    setCustomers(lateCache);
    setStatus("ready");
  }
  const [message, setMessage] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [search, setSearch] = usePersistedState("asiakkaat.search", "");
  const [showArchived, setShowArchived] = usePersistedState("asiakkaat.showArchived", false);
  // Editing an existing customer happens on its own detail page (MoreMenu ->
  // "Muokkaa"); this sheet only ever creates a new one.
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("nimi,sähköposti,puhelin,y-tunnus\n");
  const [csvRows, setCsvRows] = useState<
    Array<{ line: number; name: string | null; errors: string[] }> | null
  >(null);
  const createKey = useRef(newIdempotencyKey());

  // A message left behind by the customer detail page (e.g. "Asiakas
  // poistettiin.") after it navigated back here - shown once, then forgotten.
  useEffect(() => {
    try {
      const flash = window.sessionStorage.getItem(FLASH_KEY);
      if (flash) {
        window.sessionStorage.removeItem(FLASH_KEY);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot read of a value left by another page/navigation, not state derived from props/state here
        setMessage(flash);
      }
    } catch {
      // Session storage can throw in a locked-down browser context; the
      // flash message is a courtesy, not something the page depends on.
    }
  }, []);

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
      // Only the full list is cached: a search or archive result must never
      // paint later as if it were the whole customer list (SALES-34).
      if (!showArchived && !search.trim()) writePageCache("customers", data.customers);
      setCustomers(data.customers);
      setLoadFailure(null);
      setStatus("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      // One place for the failure (SALES-18): the notice or the stale banner,
      // never a second raw-text banner above it.
      setLoadFailure(error);
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
      const response = await apiFetch("/api/customers", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": createKey.current,
        },
        body: JSON.stringify(payload),
      });
      await readJson(response, "Tallennus epäonnistui");
      createKey.current = newIdempotencyKey();
      setCreateOpen(false);
      await load();
    } catch (error) {
      if (isUnauthorized(error)) redirectToLogin();
      throw error;
    } finally {
      setBusy(false);
    }
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
      showToast({
        tone: "success",
        text: data.created === 1 ? "1 asiakas tuotiin" : `${data.created} asiakasta tuotiin`,
      });
      setImportOpen(false);
      setCsvRows(null);
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Tuonti epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  const totalOpen = customers.reduce((sum, customer) => sum + customer.openBalance, 0);
  const csvValid = csvRows?.filter((row) => row.errors.length === 0).length ?? 0;
  const csvInvalid = (csvRows?.length ?? 0) - csvValid;

  /** A .csv from Files or iCloud, read on the device; same check as pasted text (SALES-23). */
  async function pickCsvFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_000_000) {
      showToast({ tone: "error", text: "Tiedosto on liian suuri. Enintään 1 Mt." });
      return;
    }
    try {
      // Excel on Windows saves ANSI (Windows-1252); plain file.text() garbled ä/ö.
      const text = await readTextFile(file);
      setCsv(text);
      setCsvRows(null);
      showToast({ text: `${file.name} luettiin. Tarkista rivit ennen tuontia.` });
    } catch {
      showToast({ tone: "error", text: "Tiedostoa ei voitu lukea." });
    }
  }
  const filtered = Boolean(search) || showArchived;

  return (
    <div className="space-y-6">
      <PageTitle
        title="Asiakkaat"
        action={
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="active-press relative inline-flex min-h-9 items-center gap-1 rounded-full bg-ink px-3.5 text-caption font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
          >
            <Icon icon={Plus} size="inline" strokeWidth={2.5} />
            Lisää
          </button>
        }
      />

      {status === "ready" && customers.length > 0 && (
        <SummaryCard
          label={filtered ? "Avoinna, näkyvät asiakkaat" : "Avoinna"}
          value={formatEur(totalOpen)}
          note={`${customers.length} asiakasta`}
          noteTone="muted"
        />
      )}

      {message && (
        <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
          {message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          aria-label="Hae asiakasta"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Hae nimellä"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          className={`${controlClass} min-w-0 flex-1`}
        />
        <Button type="button" variant="secondary" onClick={() => setImportOpen((open) => !open)}>
          Tuo CSV
        </Button>
      </div>

      {importOpen && (
        <Card className="space-y-3">
          <p className="text-body font-medium text-ink">Tuo asiakkaita</p>
          <p className="text-caption text-ink-2">
            Valitse CSV-tiedosto tai liitä sen sisältö. Ensimmäinen rivi on otsikko.
          </p>
          <label className={buttonClass("secondary", "w-full cursor-pointer")}>
            Valitse tiedosto
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              onChange={(event) => {
                void pickCsvFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </label>
          <textarea
            aria-label="CSV-tiedosto"
            className={`${controlClass} min-h-28 p-3`}
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
              {csvRows && csvValid > 0 ? `Tuo ${csvValid} kelvollista` : "Tuo kelvolliset"}
            </Button>
          </div>
          {csvRows && (
            <p className="text-sm font-medium text-ink" role="status">
              {csvValid} kelvollista{csvInvalid > 0 ? `, ${csvInvalid} virheellistä (ei tuoda)` : ""}
            </p>
          )}
          {csvRows && (
            <ul className="space-y-1 text-sm">
              {csvRows.map((row) => (
                <li key={row.line} className={row.errors.length ? "text-danger" : "text-ink"}>
                  Rivi {row.line}: {row.name ?? "–"}
                  {row.errors.length > 0 ? `. ${row.errors.join(" ")}` : ". Kelvollinen"}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {status === "loading" && <SkeletonList rows={4} />}
      {loadFailure != null && status === "ready" && (
        <StaleBanner fetchedAt={pageCacheFetchedAt("customers")} onRetry={() => void load()} />
      )}
      {status === "error" &&
        (isForbidden(loadFailure) ? (
          <EmptyState kind="forbidden" />
        ) : (
          <ConnectionNotice
            error={loadFailure}
            fallback={message || "Asiakkaiden haku epäonnistui"}
            onRetry={() => void load()}
          />
        ))}

      {(status === "ready" || customers.length > 0) && (
        <>
          {customers.length > 0 && (
            <Section>
              {customers.map((customer) => (
                <ListRow
                  key={customer.id}
                  href={detailHref("customer", customer.id)}
                  title={customer.name}
                  amount={formatEur(customer.openBalance)}
                  secondary={rowSecondary(customer)}
                  trailing={
                    customer.archivedAt ? <StatusTag tone="neutral">Arkistoitu</StatusTag> : undefined
                  }
                />
              ))}
            </Section>
          )}

          {customers.length === 0 && (
            <EmptyState
              kind={filtered ? "filtered" : "records"}
              title={filtered ? "Ei osumia" : "Ei asiakkaita vielä"}
              body={
                filtered
                  ? "Yksikään asiakas ei vastaa hakua."
                  : "Lisää ensimmäinen asiakas, niin laskutus löytää sen."
              }
              onCreate={!createOpen ? () => setCreateOpen(true) : undefined}
              createLabel="Lisää asiakas"
              onClear={
                filtered
                  ? () => {
                      setSearch("");
                      setShowArchived(false);
                    }
                  : undefined
              }
            />
          )}
        </>
      )}

      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={() => setShowArchived((value) => !value)}
      >
        {showArchived ? "Piilota arkistoidut" : "Näytä arkistoidut"}
      </Button>

      <BottomSheet
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Uusi asiakas"
        labelledBy="customer-sheet-title"
        heightClass="max-h-[92dvh]"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sheet-safe-bottom">
          <CustomerForm
            key={createOpen ? "new-open" : "new-closed"}
            draftKey="customer:new"
            submitLabel="Lisää asiakas"
            busy={busy}
            onSubmit={submit}
            onCancel={() => setCreateOpen(false)}
          />
        </div>
      </BottomSheet>
    </div>
  );
}
