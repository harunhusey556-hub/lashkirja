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
import { Button, controlClass } from "@/components/ui";
import { Plus } from "lucide-react";
import { Card, Icon, ListRow, MoreMenu, PageTitle, Section, StatusTag } from "@/components/ds";
import { formatDate, formatDayMonth, formatEur, parseFinnishNumber } from "@/lib/format";
import { invalidFieldProps } from "@/lib/focus-field";
import { VAT_RATES_PERMILLE } from "@/lib/invoices";
import { RECURRENCE_INTERVALS, type RecurrenceInterval } from "@/lib/recurrence";

import { pageCacheFetchedAt, readPageCache, writePageCache } from "@/lib/page-cache";
import { usePersistedState, useScrollRestoration } from "@/lib/list-ui-state";
import { isForbidden } from "@/lib/screen-state";

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
}

interface FormLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: number;
}

const INTERVAL_LABEL: Record<RecurrenceInterval, string> = {
  monthly: "Kuukausittain",
  quarterly: "Neljännesvuosittain",
  yearly: "Vuosittain",
};

const EMPTY_LINE: FormLine = {
  description: "",
  quantity: "1",
  unit: "kpl",
  unitPrice: "",
  vatRate: 25.5,
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A fresh blank form, computed at the moment it's needed (component mount, or
 * right after a successful create) rather than once at module load - so
 * `startDate` is always "today" even if the dev server has been running for
 * a while, and so this can be called again after a submit without reusing a
 * stale object reference.
 */
function makeEmptyForm() {
  return {
    customerId: "",
    name: "",
    interval: "monthly" as RecurrenceInterval,
    anchorDay: "1",
    startDate: today(),
    endDate: "",
    paymentTermDays: "14",
    autoSend: false,
    lines: [{ ...EMPTY_LINE }] as FormLine[],
  };
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

/**
 * "<customer> · <interval> · seuraava <date>" (or "· päättynyt"), with the
 * customer name omitted only when it's already the row's title (i.e. the
 * schedule has no name of its own), plus an auto-send cue when relevant.
 * Kept to one short trailing note rather than a second trailing StatusTag,
 * since the trailing slot on this row already holds an active/paused tag
 * and a MoreMenu button - a second chip there would crowd a 390px row and
 * leave little width for the text; the secondary line, being a single
 * truncating line, degrades gracefully (ellipsis) if it ever runs long.
 */
function rowSecondary(entry: RecurringInvoice): string {
  const title = entry.name || entry.customer.name;
  const parts: string[] = [];
  if (entry.customer.name !== title) parts.push(entry.customer.name);
  parts.push(INTERVAL_LABEL[entry.interval]);
  parts.push(entry.nextRunAt ? `seuraava ${formatScheduleDate(entry.nextRunAt)}` : "päättynyt");
  if (entry.autoSend) parts.push("automaattinen lähetys");
  return parts.join(" · ");
}

export default function RecurringInvoicesPage() {
  const cached = readPageCache<{ recurring: RecurringInvoice[]; dueNow: number }>("recurring");
  const [recurring, setRecurring] = useState<RecurringInvoice[]>(cached?.recurring ?? []);
  const [dueNow, setDueNow] = useState(cached?.dueNow ?? 0);
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    cached ? "ready" : "loading"
  );
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // Persisted so back-navigation restores whether inactive entries were shown.
  const [showInactive, setShowInactive] = usePersistedState("toistuvat.showInactive", false);
  const [confirmRemove, setConfirmRemove] = useState<RecurringInvoice | null>(null);

  const [form, setForm] = useState(makeEmptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [createError, setCreateError] = useState("");

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
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setMessage(errorMessage(error, "Toistuvien laskujen haku epäonnistui"));
      setStatus(readPageCache("recurring") ? "ready" : "error");
    }
  }, [showInactive]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  useScrollRestoration("toistuvat", status === "ready");

  useEffect(() => {
    apiFetch("/api/customers", { credentials: "include" })
      .then((response) => readJson<{ customers: Array<{ id: string; name: string }> }>(response, ""))
      .then((data) => setCustomers(data.customers ?? []))
      .catch(() => {});
  }, []);

  function setLine(index: number, patch: Partial<FormLine>) {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  // Deliberately does not reset the form: closing the sheet (Peruuta, the
  // backdrop, Escape) is not the same as having created the invoice, and an
  // accidental close shouldn't lose everything already typed in - reopening
  // picks the same draft back up. The form only resets after `submit`
  // actually succeeds, below.
  function openCreate() {
    setCreateOpen(true);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!form.customerId) nextErrors.customerId = "Valitse asiakas.";
    const anchorDay = Number(form.anchorDay);
    if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
      nextErrors.anchorDay = "Laskutuspäivä on 1-31.";
    }
    if (form.endDate && form.endDate < form.startDate) {
      nextErrors.endDate = "Päättymispäivä ei voi olla ennen alkupäivää.";
    }

    const lines = form.lines
      .map((line) => {
        const quantity = parseFinnishNumber(line.quantity);
        const unitPrice = parseFinnishNumber(line.unitPrice);
        if (!line.description.trim() || quantity === null || unitPrice === null) return null;
        return {
          description: line.description.trim(),
          quantity,
          unit: line.unit.trim() || "kpl",
          unitPrice,
          vatRate: line.vatRate,
        };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);
    if (lines.length === 0) nextErrors.lines = "Lisää vähintään yksi rivi.";

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setCreateError("");
    setBusy(true);

    try {
      const response = await apiFetch("/api/recurring-invoices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: form.customerId,
          name: form.name.trim() || null,
          interval: form.interval,
          anchorDay,
          startDate: form.startDate,
          endDate: form.endDate || null,
          paymentTermDays: Number(form.paymentTermDays) || 14,
          autoSend: form.autoSend,
          lines,
        }),
      });
      await readJson(response, "Tallennus epäonnistui");
      setCreateOpen(false);
      setForm(makeEmptyForm());
      setErrors({});
      await load();
    } catch (error) {
      // Renders inside the "Uusi toistuva lasku" sheet, which stays open, not
      // the page-level message behind it.
      setCreateError(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  async function runDue(recurringInvoiceId?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await apiFetch("/api/recurring-invoices/run", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recurringInvoiceId ? { recurringInvoiceId } : {}),
      });
      const result = await readJson<{
        generated: Array<{ invoiceNumber: number; sent: boolean; sendError: string | null }>;
        skipped: Array<{ reason: string }>;
      }>(response, "Laskujen luonti epäonnistui");

      const failedSends = result.generated.filter((entry) => entry.sendError).length;
      setMessage(
        `Luotiin ${result.generated.length} laskua.` +
          (result.skipped.length ? ` ${result.skipped.length} ohitettiin.` : "") +
          (failedSends ? ` ${failedSends} laskun lähetys epäonnistui. Lasku on silti tallessa.` : "")
      );
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Laskujen luonti epäonnistui"));
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
      await load();
    } catch (error) {
      setMessage(errorMessage(error, "Muutos epäonnistui"));
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
      setMessage("Toistuva lasku poistettiin. Jo luodut laskut säilyvät.");
      setConfirmRemove(null);
      await load();
    } catch (error) {
      const failureMessage = errorMessage(error, "Poisto epäonnistui");
      setMessage(failureMessage);
      throw new Error(failureMessage);
    } finally {
      setBusy(false);
    }
  }

  const field = `${controlClass} min-h-12`;
  const label = "mb-1.5 block text-[13px] font-normal text-ink-2";
  const lineLabel = "mb-1 block text-xs font-normal text-ink-2";

  return (
    <>
      <div className="space-y-6">
        <PageTitle
          title="Toistuvat laskut"
          action={
            <button
              type="button"
              onClick={openCreate}
              aria-label="Uusi toistuva lasku"
              className="active-press relative inline-flex min-h-9 items-center gap-1 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-canvas before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']"
            >
              <Icon icon={Plus} size="inline" strokeWidth={2.5} />
              Uusi
            </button>
          }
        />

        {dueNow > 0 && (
          <Card className="space-y-3">
            <p className="text-[15px] text-ink">
              {dueNow === 1
                ? "1 toistuva lasku on erääntynyt luotavaksi."
                : `${dueNow} toistuvaa laskua on erääntynyt luotavaksi.`}
            </p>
            <Button type="button" className="w-full" busy={busy} busyLabel="Luodaan…" onClick={() => void runDue()}>
              Luo erääntyneet laskut
            </Button>
          </Card>
        )}

        {message && (
          <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
            {message}
          </p>
        )}

        {status === "loading" && <SkeletonList rows={4} />}
        {loadFailure != null && status === "ready" && (
          <StaleBanner fetchedAt={pageCacheFetchedAt("recurring")} onRetry={() => void load()} />
        )}
        {status === "error" &&
          (isForbidden(loadFailure) ? (
            <EmptyState kind="forbidden" />
          ) : (
            <ConnectionNotice
              error={loadFailure}
              fallback={message || "Toistuvien laskujen haku epäonnistui"}
              onRetry={() => void load()}
            />
          ))}

        {status === "ready" && recurring.length > 0 && (
          <Section>
            {recurring.map((entry) => (
              <ListRow
                key={entry.id}
                title={entry.name || entry.customer.name}
                amount={formatEur(entry.total)}
                secondary={rowSecondary(entry)}
                trailing={
                  <div className="flex items-center gap-1.5">
                    <StatusTag tone={entry.active ? "success" : "neutral"}>
                      {entry.active ? "Aktiivinen" : "Pysäytetty"}
                    </StatusTag>
                    <MoreMenu
                      label={`Lisää toimintoja: ${entry.name || entry.customer.name}`}
                      items={[
                        // Not a real action (disabled, no-op): an info line for
                        // the details that don't fit on the row itself and
                        // have nowhere else to live (there is no recurring
                        // schedule detail page) - laskutuspäivä and how many
                        // invoices it has generated so far. Repeats the next
                        // run date too (already in `secondary`, above the
                        // fold on the row) since a long name/customer/interval
                        // combination can truncate it away on a narrow phone;
                        // this menu item doesn't truncate, so it's the
                        // reliable place to actually read it.
                        {
                          label: [
                            entry.nextRunAt ? `Seuraava ${formatScheduleDate(entry.nextRunAt)}` : "Päättynyt",
                            `Laskutuspäivä ${entry.anchorDay}.`,
                            `${entry.generatedCount} laskua luotu`,
                          ].join(" · "),
                          onSelect: () => {},
                          disabled: true,
                        },
                        ...(entry.active && entry.nextRunAt
                          ? [{ label: "Luo nyt", onSelect: () => void runDue(entry.id), disabled: busy }]
                          : []),
                        {
                          label: entry.active ? "Pysäytä" : "Jatka",
                          onSelect: () => void toggleActive(entry),
                          disabled: busy,
                        },
                        {
                          label: "Poista",
                          onSelect: () => setConfirmRemove(entry),
                          tone: "danger" as const,
                          disabled: busy,
                        },
                      ]}
                    />
                  </div>
                }
              />
            ))}
          </Section>
        )}

        {status === "ready" && recurring.length === 0 && (
          <EmptyState
            kind={showInactive ? "records" : "filtered"}
            title={showInactive ? "Ei toistuvia laskuja" : "Ei aktiivisia toistuvia laskuja"}
            body={
              showInactive
                ? "Luo ensimmäinen toistuva lasku, kun asiakkaalla on säännöllinen veloitus."
                : "Kaikki toistuvat laskut on pysäytetty tai niitä ei ole vielä luotu."
            }
            onClear={showInactive ? undefined : () => setShowInactive(true)}
            clearLabel="Näytä myös pysäytetyt"
          />
        )}

        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => setShowInactive((value) => !value)}
        >
          {showInactive ? "Piilota pysäytetyt" : "Näytä pysäytetyt"}
        </Button>
      </div>

      <BottomSheet
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Uusi toistuva lasku"
        labelledBy="recurring-sheet-title"
        heightClass="max-h-[94dvh]"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sheet-safe-bottom">
          {customers.length === 0 ? (
            <p className="text-[15px] text-ink-2">
              Lisää ensin asiakas <Link className="text-accent" href="/asiakkaat">Asiakkaat</Link>-sivulla.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div>
                <label className={label} htmlFor="ri-customer">Asiakas</label>
                <select
                  className={field}
                  value={form.customerId}
                  onChange={(e) => setForm({ ...form, customerId: e.target.value })}
                  {...invalidFieldProps("ri-customer", errors.customerId)}
                >
                  <option value="">Valitse asiakas</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
                {errors.customerId && (
                  <p id="ri-customer-error" className="mt-1.5 text-sm text-danger" role="alert">
                    {errors.customerId}
                  </p>
                )}
              </div>

              <div className="field-grid">
                <div>
                  <label className={label} htmlFor="ri-interval">Toistoväli</label>
                  <select
                    id="ri-interval"
                    className={field}
                    value={form.interval}
                    onChange={(e) =>
                      setForm({ ...form, interval: e.target.value as RecurrenceInterval })
                    }
                  >
                    {RECURRENCE_INTERVALS.map((interval) => (
                      <option key={interval} value={interval}>
                        {INTERVAL_LABEL[interval]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="ri-anchor">Laskutuspäivä</label>
                  <input
                    className={field}
                    value={form.anchorDay}
                    onChange={(e) => setForm({ ...form, anchorDay: e.target.value })}
                    inputMode="numeric"
                    {...invalidFieldProps("ri-anchor", errors.anchorDay, "ri-anchor-hint")}
                  />
                  {errors.anchorDay ? (
                    <p id="ri-anchor-error" className="mt-1.5 text-sm text-danger" role="alert">
                      {errors.anchorDay}
                    </p>
                  ) : (
                    <p id="ri-anchor-hint" className="mt-1.5 text-xs text-ink-2">
                      31 tarkoittaa kuun viimeistä päivää lyhyissä kuukausissa.
                    </p>
                  )}
                </div>
              </div>

              <div className="field-dates">
                <div>
                  <label className={label} htmlFor="ri-start">Alkaa</label>
                  <input
                    id="ri-start"
                    type="date"
                    className={field}
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </div>
                <div>
                  <label className={label} htmlFor="ri-end">Päättyy (valinnainen)</label>
                  <input
                    type="date"
                    className={field}
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    {...invalidFieldProps("ri-end", errors.endDate)}
                  />
                  {errors.endDate && (
                    <p id="ri-end-error" className="mt-1.5 text-sm text-danger" role="alert">
                      {errors.endDate}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <p className="text-[13px] text-ink-2">Rivit</p>
                {form.lines.map((line, index) => (
                  <Card key={index} className="space-y-2">
                    <label className={lineLabel} htmlFor={`ri-line-${index}-desc`}>Kuvaus</label>
                    <input
                      id={`ri-line-${index}-desc`}
                      aria-label={`Rivin ${index + 1} kuvaus`}
                      className={field}
                      value={line.description}
                      onChange={(e) => setLine(index, { description: e.target.value })}
                      placeholder="Kuvaus"
                      // "Lisää vähintään yksi rivi" doesn't identify which
                      // line is incomplete, so it's tied to the first line's
                      // description field - the one that's empty in the
                      // common single-line case this error actually fires for.
                      aria-invalid={index === 0 && errors.lines ? true : undefined}
                      aria-describedby={index === 0 && errors.lines ? "ri-lines-error" : undefined}
                    />
                    <div className="field-grid field-grid-3">
                      <div>
                        <label className={lineLabel} htmlFor={`ri-line-${index}-qty`}>Määrä</label>
                        <input
                          id={`ri-line-${index}-qty`}
                          aria-label={`Rivin ${index + 1} määrä`}
                          className={field}
                          value={line.quantity}
                          onChange={(e) => setLine(index, { quantity: e.target.value })}
                          inputMode="decimal"
                        />
                      </div>
                      <div>
                        <label className={lineLabel} htmlFor={`ri-line-${index}-unit`}>Yksikkö</label>
                        <input
                          id={`ri-line-${index}-unit`}
                          aria-label={`Rivin ${index + 1} yksikkö`}
                          className={field}
                          value={line.unit}
                          onChange={(e) => setLine(index, { unit: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className={lineLabel} htmlFor={`ri-line-${index}-price`}>Hinta €</label>
                        <input
                          id={`ri-line-${index}-price`}
                          aria-label={`Rivin ${index + 1} hinta`}
                          className={field}
                          value={line.unitPrice}
                          onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                          inputMode="decimal"
                          placeholder="0,00"
                        />
                      </div>
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <label className={lineLabel} htmlFor={`ri-line-${index}-vat`}>ALV</label>
                        <select
                          id={`ri-line-${index}-vat`}
                          aria-label={`Rivin ${index + 1} ALV`}
                          className={field}
                          value={line.vatRate}
                          onChange={(e) => setLine(index, { vatRate: Number(e.target.value) })}
                        >
                          {VAT_RATES_PERMILLE.map((permille) => (
                            <option key={permille} value={permille / 10}>
                              ALV {permille / 10} %
                            </option>
                          ))}
                        </select>
                      </div>
                      {form.lines.length > 1 && (
                        <Button
                          type="button"
                          variant="danger"
                          className="shrink-0"
                          onClick={() =>
                            setForm({
                              ...form,
                              lines: form.lines.filter((_, i) => i !== index),
                            })
                          }
                        >
                          Poista
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  onClick={() => setForm({ ...form, lines: [...form.lines, { ...EMPTY_LINE }] })}
                >
                  Lisää rivi
                </Button>
                {errors.lines && (
                  <p id="ri-lines-error" className="text-sm text-danger" role="alert">
                    {errors.lines}
                  </p>
                )}
              </div>

              <label className="flex items-center gap-3 text-[15px] text-ink">
                <input
                  type="checkbox"
                  checked={form.autoSend}
                  onChange={(e) => setForm({ ...form, autoSend: e.target.checked })}
                  className="h-4 w-4"
                />
                Lähetä lasku asiakkaalle sähköpostilla heti kun se luodaan
              </label>

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
                  Luo toistuva lasku
                </Button>
              </div>
            </form>
          )}
        </div>
      </BottomSheet>

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
