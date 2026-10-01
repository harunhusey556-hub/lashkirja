"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import { Button } from "@/components/ui";
import { Repeat } from "lucide-react";
import { Card, FilterChips, HeaderAddPill, KeyValueList, ListRow, PageTitle, Section, StatusTag } from "@/components/ds";
import { formatDate, formatDayMonth, formatEur } from "@/lib/format";
import { type RecurrenceInterval } from "@/lib/recurrence";
import { detailHref } from "@/lib/routes";
import { helsinkiCalendarDate } from "@/lib/validation";
import {
  INTERVAL_LABEL,
  RecurringForm,
  emptyRecurringForm,
  type RecurringCustomer,
  type RecurringFormValues,
  type RecurringPayload,
} from "@/components/invoices/RecurringForm";
import { QuickCustomerSheet, type CreatedCustomer } from "@/components/invoices/QuickCustomerSheet";
import { useProfile } from "@/app/asetukset/useProfile";
import { adjustVatRateForDate } from "@/lib/invoices";
import { lockedOnlyMessage, runPlanInvoiceCount, runPlanSummary, runResultSummary, type RunPlan } from "./runPlan";

import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { useCacheAfterBoot } from "@/components/invoices/useCacheAfterBoot";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { isForbidden } from "@/lib/screen-state";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";
import { tintedButtonClass } from "@/components/control-styles";

interface RecurringInvoice {
  id: string;
  name: string | null;
  interval: RecurrenceInterval;
  anchorDay: number;
  startDate: string;
  endDate: string | null;
  nextRunAt: string | null;
  paymentTermDays: number;
  autoSend: boolean;
  active: boolean;
  customer: { id: string; name: string; email: string | null };
  lines: Array<{ id: string; description: string; quantity: number; unit: string; unitPrice: number; vatRate: number }>;
  total: number;
  generatedCount: number;
  lastRun: { issueDate: string; status: string; invoiceId: string | null } | null;
  // Absent in a copy cached before these existed.
  missedRuns?: Array<{ issueDate: string; reason: "period_locked" | "failed"; note: string | null }>;
  failedSends?: Array<{ issueDate: string; invoiceId: string; note: string | null }>;
}

/**
 * "d.m." for a date inside the current year that hasn't passed yet;
 * "d.m.yyyy" otherwise (past or a different year), so a schedule that's
 * fallen behind (or simply runs into next year) doesn't read as if it were
 * due any day now.
 */
function formatScheduleDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const needsYear = date.getTime() < todayUtc || date.getUTCFullYear() !== now.getUTCFullYear();
  return needsYear ? formatDate(value) : formatDayMonth(value);
}

/** "<customer> · <interval> · seuraava <date>", customer omitted when it is the title. */
function rowSecondary(entry: RecurringInvoice): string {
  const title = entry.name || entry.customer.name;
  const parts: string[] = [];
  if (entry.customer.name !== title) parts.push(entry.customer.name);
  parts.push(INTERVAL_LABEL[entry.interval]);
  parts.push(entry.nextRunAt ? `seuraava ${formatScheduleDate(entry.nextRunAt)}` : "päättynyt");
  if (entry.autoSend) parts.push("lähetetään automaattisesti");
  if (entry.failedSends?.length) parts.push("lähetys epäonnistui");
  if (entry.missedRuns?.length) parts.push("lasku jäi luomatta");
  return parts.join(" · ");
}

function isDue(entry: RecurringInvoice): boolean {
  return Boolean(entry.active && entry.nextRunAt && entry.nextRunAt.slice(0, 10) <= helsinkiCalendarDate());
}

function toFormValues(entry: RecurringInvoice): RecurringFormValues {
  const decimal = (value: number, fixed?: number) =>
    (fixed === undefined ? String(value) : value.toFixed(fixed)).replace(".", ",");
  return {
    customerId: entry.customer.id,
    name: entry.name ?? "",
    interval: entry.interval,
    anchorDay: String(entry.anchorDay),
    startDate: entry.startDate.slice(0, 10),
    endDate: entry.endDate ? entry.endDate.slice(0, 10) : "",
    paymentTermDays: String(entry.paymentTermDays),
    autoSend: entry.autoSend,
    lines: entry.lines.map((line) => ({
      description: line.description,
      quantity: decimal(line.quantity),
      unit: line.unit,
      unitPrice: decimal(line.unitPrice, 2),
      vatRate: line.vatRate,
    })),
  };
}

export default function RecurringInvoicesPage() {
  // The seller's VAT status decides whether the form offers an ALV choice (F01).
  const { profile, loadError: profileError, retry: retryProfile } = useProfile();
  // The rate a run bills today: 0 % for a seller who is not VAT registered, and
  // the 13,5 % that replaced 14 % (what the run itself does), not the stored one.
  const shownVatRate = (stored: number) =>
    profile && !profile.vatRegistered
      ? 0
      : adjustVatRateForDate(Math.round(stored * 10), new Date().toISOString().slice(0, 10)) / 10;
  const cached = readPageCache<{ recurring: RecurringInvoice[]; dueNow: number }>("recurring");
  const [recurring, setRecurring] = useState<RecurringInvoice[]>(cached?.recurring ?? []);
  const [dueNow, setDueNow] = useState(cached?.dueNow ?? 0);
  const [customers, setCustomers] = useState<RecurringCustomer[] | null>(null);
  const [customersError, setCustomersError] = useState<unknown>(null);
  const [customersAttempt, setCustomersAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  // Cold launch: the cache is hydrated after this page mounted (bootMobile),
  // so paint it once it is there instead of holding the skeleton.
  const lateCache = useCacheAfterBoot<{ recurring: RecurringInvoice[]; dueNow: number }>("recurring");
  const [appliedLateCache, setAppliedLateCache] = useState<unknown>(null);
  if (lateCache && lateCache !== appliedLateCache && status === "loading") {
    setAppliedLateCache(lateCache);
    setRecurring(lateCache.recurring);
    setDueNow(lateCache.dueNow);
    setStatus("ready");
  }
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // Which sheet is open: a new schedule, an edit, or none.
  const [formFor, setFormFor] = useState<"new" | RecurringInvoice | null>(null);
  const [formError, setFormError] = useState("");
  const [selected, setSelected] = useState<RecurringInvoice | null>(null);
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);
  const [pendingCustomer, setPendingCustomer] = useState<string | null>(null);
  // Persisted so back-navigation restores whether inactive entries were shown.
  const [showInactive, setShowInactive] = usePersistedState("toistuvat.showInactive", false);
  const [hasAny, setHasAny] = useState<boolean | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<RecurringInvoice | null>(null);
  const [runPlan, setRunPlan] = useState<RunPlan["plan"] | null>(null);
  const [runScope, setRunScope] = useState<string | undefined>(undefined);
  const [planLoading, setPlanLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(
        `/api/recurring-invoices${showInactive ? "?includeInactive=1" : ""}`,
        { credentials: "include" }
      );
      const data = await readJson<{ recurring: RecurringInvoice[]; dueNow: number }>(
        response,
        "Toistuvien laskujen haku epäonnistui"
      );
      writePageCache("recurring", data);
      setRecurring(data.recurring);
      setDueNow(data.dueNow);
      setLoadFailure(null);
      setStatus("ready");
      // An empty active list may still hide paused schedules: ask once, so a
      // brand-new user sees "create the first one", not the filter copy (SALES-20).
      if (data.recurring.length === 0 && !showInactive) {
        const all = await apiFetch("/api/recurring-invoices?includeInactive=1", { credentials: "include" })
          .then((res) => readJson<{ recurring: unknown[] }>(res, ""))
          .catch(() => null);
        setHasAny(all ? all.recurring.length > 0 : null);
      } else {
        setHasAny(data.recurring.length > 0 ? true : null);
      }
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setStatus(readPageCache("recurring") ? "ready" : "error");
    }
  }, [showInactive]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  useScrollRestoration("toistuvat", status === "ready");

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/customers", { credentials: "include" })
      .then((response) => readJson<{ customers: RecurringCustomer[] }>(response, "Asiakkaiden haku epäonnistui"))
      .then((data) => {
        if (cancelled) return;
        setCustomers(data.customers ?? []);
        setCustomersError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCustomersError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [customersAttempt]);

  async function save(payload: RecurringPayload): Promise<boolean> {
    const editing = formFor && formFor !== "new" ? formFor : null;
    setBusy(true);
    setFormError("");
    try {
      const response = await apiFetch(
        editing ? `/api/recurring-invoices/${editing.id}` : "/api/recurring-invoices",
        {
          method: editing ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      await readJson(response, "Tallennus epäonnistui");
      setFormFor(null);
      setPendingCustomer(null);
      showToast({
        tone: "success",
        text: editing ? "Muutokset tallennettiin" : "Toistuva lasku luotiin",
      });
      await load();
      return true;
    } catch (error) {
      // Renders inside the sheet, which stays open.
      setFormError(errorMessage(error, "Tallennus epäonnistui"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Step 1: show exactly what would be created and sent (SALES-05). */
  async function previewRun(recurringInvoiceId?: string) {
    if (planLoading) return;
    setPlanLoading(true);
    try {
      const query = recurringInvoiceId ? `?recurringInvoiceId=${encodeURIComponent(recurringInvoiceId)}` : "";
      const response = await apiFetch(`/api/recurring-invoices/run${query}`, { credentials: "include" });
      const data = await readJson<RunPlan>(response, "Tarkistus epäonnistui");
      if (data.plan.length === 0) {
        showToast({ text: "Yhtään laskua ei ole juuri nyt luotavana." });
        return;
      }
      if (runPlanInvoiceCount(data.plan) === 0) {
        // Everything due is inside a closed month: there is nothing to confirm.
        showToast({ tone: "info", text: lockedOnlyMessage(data.plan), durationMs: 9000 });
        return;
      }
      setRunScope(recurringInvoiceId);
      setRunPlan(data.plan);
    } catch (error) {
      showToast({ tone: "error", text: errorMessage(error, "Tarkistus epäonnistui") });
    } finally {
      setPlanLoading(false);
    }
  }

  /** Step 2: create them. */
  async function runDue() {
    setBusy(true);
    try {
      const response = await apiFetch("/api/recurring-invoices/run", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runScope ? { recurringInvoiceId: runScope } : {}),
      });
      const result = await readJson<{
        generated: Array<{ invoiceNumber: number; sent: boolean; sendError: string | null }>;
        skipped: Array<{ reason: string; issueDate: string }>;
        sendRetries?: Array<{ sent: boolean }>;
      }>(response, "Laskujen luonti epäonnistui");
      setRunPlan(null);
      setSelected(null);
      const summary = runResultSummary(result);
      void hapticNotify(summary.tone === "success" ? "success" : "warning");
      showToast({ tone: summary.tone, text: summary.text, durationMs: summary.durationMs });
      await load();
    } catch (error) {
      void hapticNotify("error");
      // The confirmation stays open and shows the message (IA-12: one confirmation pattern).
      throw new Error(errorMessage(error, "Laskujen luonti epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(entry: RecurringInvoice) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/recurring-invoices/${entry.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !entry.active }),
      });
      await readJson(response, "Muutos epäonnistui");
      setSelected(null);
      // Pausing is reversible: say so and offer the way back (T4).
      showToast({
        text: entry.active ? "Toistuva lasku pysäytettiin" : "Toistuva lasku jatkuu",
        action: entry.active
          ? {
              label: "Kumoa",
              onAction: () => void toggleActive({ ...entry, active: false }),
            }
          : undefined,
      });
      await load();
    } catch (error) {
      showToast({ tone: "error", text: errorMessage(error, "Muutos epäonnistui") });
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: RecurringInvoice) {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/recurring-invoices/${entry.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await readJson(response, "Poisto epäonnistui");
      showToast({ text: "Toistuva lasku poistettiin. Jo luodut laskut säilyvät." });
      setConfirmRemove(null);
      setSelected(null);
      await load();
    } catch (error) {
      throw new Error(errorMessage(error, "Poisto epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  function onCustomerCreated(customer: CreatedCustomer) {
    setCustomers((current) =>
      [...(current ?? []), customer].sort((a, b) => a.name.localeCompare(b.name, "fi"))
    );
    setPendingCustomer(customer.id);
  }

  const editing = formFor && formFor !== "new" ? formFor : null;
  const planCount = runPlanInvoiceCount(runPlan);

  return (
    <>
      <div className="space-y-6">
        <PageTitle
          title="Toistuvat"
          action={
            <HeaderAddPill
              label="Uusi toistuva lasku"
              onClick={() => {
                setFormError("");
                setFormFor("new");
              }}
            />
          }
        />

        {dueNow > 0 && (
          <Card className="space-y-3">
            <p className="text-body text-ink">
              {dueNow === 1
                ? "1 toistuva lasku odottaa luontia."
                : `${dueNow} toistuvaa laskua odottaa luontia.`}
            </p>
            <Button
              type="button"
              className="w-full"
              busy={planLoading && runScope === undefined}
              busyLabel="Tarkistetaan…"
              onClick={() => void previewRun()}
            >
              Luo odottavat laskut
            </Button>
          </Card>
        )}

        {status === "loading" && <SkeletonList rows={3} />}
        {loadFailure != null && status === "ready" && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("recurring")} onRetry={() => void load()} />
        )}
        {status === "error" &&
          (isForbidden(loadFailure) ? (
            <EmptyState kind="forbidden" />
          ) : (
            <ConnectionNotice
              error={loadFailure}
              fallback="Toistuvien laskujen haku epäonnistui"
              onRetry={() => void load()}
            />
          ))}

        {status !== "error" && (recurring.length > 0 || showInactive || hasAny) && (
          <FilterChips
            label="Suodata toistuvat laskut"
            items={[
              { id: "active", label: "Aktiiviset" },
              { id: "all", label: "Myös pysäytetyt" },
            ]}
            value={showInactive ? "all" : "active"}
            onChange={(id) => setShowInactive(id === "all")}
          />
        )}

        {status === "ready" && recurring.length > 0 && (
          <Section>
            {recurring.map((entry) => (
              <ListRow
                key={entry.id}
                onClick={() => setSelected(entry)}
                chevron
                title={entry.name || entry.customer.name}
                amount={formatEur(entry.total)}
                secondary={rowSecondary(entry)}
                ariaLabel={`${entry.name || entry.customer.name}, ${formatEur(entry.total)}, ${rowSecondary(entry)}, ${entry.active ? "aktiivinen" : "pysäytetty"}`}
                trailing={
                  entry.active ? undefined : <StatusTag tone="neutral">Pysäytetty</StatusTag>
                }
              />
            ))}
          </Section>
        )}

        {status === "ready" && recurring.length === 0 &&
          (hasAny === false || showInactive ? (
            <EmptyState
              kind="records"
              icon={Repeat}
              title="Ei toistuvia laskuja vielä"
              body="Kun asiakas maksaa säännöllisesti, lasku tehdään tästä joka kerta itsestään."
              onCreate={() => {
                setFormError("");
                setFormFor("new");
              }}
              createLabel="Uusi toistuva lasku"
            />
          ) : (
            <EmptyState
              kind="filtered"
              title="Ei aktiivisia toistuvia laskuja"
              body="Kaikki toistuvat laskut on pysäytetty."
              onClear={() => setShowInactive(true)}
              clearLabel="Näytä myös pysäytetyt"
            />
          ))}

      </div>

      {/* Schedule detail: every fact in one place, with its actions (SALES-12). */}
      <BottomSheet
        isOpen={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.name || selected.customer.name : "Toistuva lasku"}
        labelledBy="recurring-detail-title"
        heightClass="max-h-[90dvh]"
      >
        {selected && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 sheet-safe-bottom [&>*]:shrink-0">
            <KeyValueList
              rows={[
                { label: "Asiakas", value: selected.customer.name },
                { label: "Toistoväli", value: INTERVAL_LABEL[selected.interval] },
                { label: "Laskutuspäivä", value: `${selected.anchorDay}.` },
                {
                  label: "Seuraava",
                  value: selected.nextRunAt ? formatScheduleDate(selected.nextRunAt) : "Päättynyt",
                },
                { label: "Alkaa", value: formatDate(selected.startDate) },
                ...(selected.endDate ? [{ label: "Päättyy", value: formatDate(selected.endDate) }] : []),
                { label: "Maksuaika", value: `${selected.paymentTermDays} pv` },
                {
                  label: "Lähetys",
                  value: selected.autoSend ? "Sähköpostilla automaattisesti" : "Jää luonnokseksi",
                },
                { label: "Luotu", value: `${selected.generatedCount} laskua` },
                { label: "Yhteensä (veroton)", value: formatEur(selected.total) },
              ]}
            />
            {(selected.failedSends ?? []).map((failed) => (
              <div
                key={failed.invoiceId}
                role="status"
                className="rounded-card border border-danger/30 bg-danger/10 px-4 py-3 text-body text-ink"
              >
                <p>
                  Laskun {formatDate(failed.issueDate)} automaattinen lähetys epäonnistui. Lasku on tallessa
                  luonnoksena.
                </p>
                <Link
                  href={detailHref("invoice", failed.invoiceId)}
                  className={tintedButtonClass("accent")}
                >
                  Avaa lasku ja lähetä
                </Link>
              </div>
            ))}
            {(selected.missedRuns ?? []).length > 0 && (
              <div role="status" className="rounded-card border border-line bg-surface px-4 py-3 text-body text-ink">
                <p>
                  Jäi luomatta: {(selected.missedRuns ?? []).map((missed) => formatDate(missed.issueDate)).join(", ")}.{" "}
                  {(selected.missedRuns ?? []).every((missed) => missed.reason === "period_locked")
                    ? "Kausi on suljettu. Laskut luodaan, kun avaat kauden."
                    : "Laskun luonti epäonnistui."}
                </p>
                <Link href="/kirjanpito/kaudet" className={tintedButtonClass("accent")}>
                  Avaa kaudet
                </Link>
              </div>
            )}
            <Section title="Rivit" className="mt-0">
              {selected.lines.map((line) => (
                <ListRow
                  key={line.id}
                  title={line.description}
                  amount={formatEur(line.quantity * line.unitPrice)}
                  secondary={`${String(line.quantity).replace(".", ",")} ${line.unit} × ${formatEur(line.unitPrice)} · ALV ${String(shownVatRate(line.vatRate)).replace(".", ",")} %`}
                />
              ))}
            </Section>
            {selected.lastRun?.invoiceId && (
              <Link
                href={detailHref("invoice", selected.lastRun.invoiceId)}
                className={tintedButtonClass("accent")}
              >
                Avaa viimeisin lasku ({formatDate(selected.lastRun.issueDate)})
              </Link>
            )}
            <div className="space-y-2">
              {isDue(selected) && (
                <Button
                  type="button"
                  className="w-full"
                  busy={planLoading && runScope === selected.id}
                  busyLabel="Tarkistetaan…"
                  disabled={busy}
                  onClick={() => void previewRun(selected.id)}
                >
                  Luo lasku nyt
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={busy}
                onClick={() => {
                  setFormError("");
                  setFormFor(selected);
                  setSelected(null);
                }}
              >
                Muokkaa
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={busy}
                onClick={() => void toggleActive(selected)}
              >
                {selected.active ? "Pysäytä" : "Jatka"}
              </Button>
              <button
                type="button"
                className={tintedButtonClass("danger", "w-full")}
                disabled={busy}
                onClick={() => setConfirmRemove(selected)}
              >
                Poista
              </button>
            </div>
          </div>
        )}
      </BottomSheet>

      <BottomSheet
        isOpen={formFor !== null}
        onClose={() => setFormFor(null)}
        title={editing ? "Muokkaa toistuvaa laskua" : "Uusi toistuva lasku"}
        labelledBy="recurring-sheet-title"
        heightClass="max-h-[94dvh]"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sheet-safe-bottom">
          {formFor !== null && profile === null && !profileError && (
            <p className="text-caption text-ink-2" role="status">
              Ladataan…
            </p>
          )}
          {formFor !== null && profile === null && Boolean(profileError) && (
            <ConnectionNotice
              error={profileError}
              fallback="Yrityksen tietojen haku epäonnistui"
              onRetry={retryProfile}
            />
          )}
          {formFor !== null && profile !== null && (
            <RecurringForm
              key={`${editing ? editing.id : "new"}:${pendingCustomer ?? ""}`}
              vatRegistered={profile?.vatRegistered ?? true}
              customers={customers}
              customersError={customersError}
              onRetryCustomers={() => setCustomersAttempt((value) => value + 1)}
              initial={
                editing
                  ? toFormValues(editing)
                  : pendingCustomer
                    ? {
                        ...emptyRecurringForm(profile?.vatRegistered ?? true),
                        customerId: pendingCustomer,
                        paymentTermDays: String(
                          customers?.find((c) => c.id === pendingCustomer)?.defaultPaymentTermDays ?? 14
                        ),
                      }
                    : undefined
              }
              draftKey={editing ? `recurring:edit:${editing.id}` : "recurring:new"}
              submitLabel={editing ? "Tallenna muutokset" : "Luo toistuva lasku"}
              busy={busy}
              error={formError}
              onAddCustomer={() => {
                setFormFor(null);
                setAddCustomerOpen(true);
              }}
              onSubmit={save}
              onCancel={() => setFormFor(null)}
            />
          )}
        </div>
      </BottomSheet>

      <QuickCustomerSheet
        isOpen={addCustomerOpen}
        onClose={() => setAddCustomerOpen(false)}
        onCreated={(customer) => {
          onCustomerCreated(customer);
          // Back to the schedule, with the new customer already chosen.
          window.setTimeout(() => setFormFor("new"), 0);
        }}
      />

      {/* Confirmation before invoices are created or e-mailed (SALES-05). A ConfirmModal like every other
          confirmation (IA-12): the plan is summarised in its description. */}
      <ConfirmModal
        isOpen={runPlan !== null}
        title={planCount === 1 ? "Luodaanko 1 lasku?" : `Luodaanko ${planCount} laskua?`}
        description={runPlanSummary(runPlan)}
        confirmLabel={planCount === 1 ? "Luo lasku" : `Luo ${planCount} laskua`}
        isDestructive={false}
        onConfirm={() => runDue()}
        onCancel={() => setRunPlan(null)}
      />

      <ConfirmModal
        isOpen={confirmRemove !== null}
        title="Poistetaanko toistuva lasku?"
        description={
          confirmRemove
            ? `${confirmRemove.name || confirmRemove.customer.name}. Jo luodut laskut säilyvät.`
            : ""
        }
        confirmLabel="Poista"
        onConfirm={() => (confirmRemove ? remove(confirmRemove) : Promise.resolve())}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
