"use client";

import { useLineKeys } from "./useLineKeys";
import { AnimatedRows } from "@/components/AnimatedRows";
import { CustomSelect } from "@/components/CustomSelect";
import { useState } from "react";
import { useEditorSession } from "@/components/form-session";
import { ConnectionNotice } from "@/components/ScreenState";
import { Button, controlClass } from "@/components/ui";
import { Card } from "@/components/ds";
import { followSellerVat, vatRateDateNote } from "./InvoiceForm";
import { focusFirstInvalid, invalidFieldProps } from "@/lib/focus-field";
import { parseFinnishNumber, parseMoneyInput } from "@/lib/format";
import {
  applySellerVatRules,
  InvoiceValidationError,
  vatRateLabel,
  vatRatesForDate,
} from "@/lib/invoices";
import { firstRun, RECURRENCE_INTERVALS, type RecurrenceInterval } from "@/lib/recurrence";
import { helsinkiCalendarDate, isStrictIsoDate } from "@/lib/validation";
import { compactActionClass } from "@/components/control-styles";

export const INTERVAL_LABEL: Record<RecurrenceInterval, string> = {
  monthly: "Kuukausittain",
  quarterly: "Neljännesvuosittain",
  yearly: "Vuosittain",
};

export interface RecurringFormLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: number;
}

export interface RecurringFormValues {
  customerId: string;
  name: string;
  interval: RecurrenceInterval;
  anchorDay: string;
  startDate: string;
  endDate: string;
  paymentTermDays: string;
  autoSend: boolean;
  lines: RecurringFormLine[];
}

export interface RecurringPayload {
  customerId: string;
  name: string | null;
  interval: RecurrenceInterval;
  anchorDay: number;
  startDate: string;
  endDate: string | null;
  paymentTermDays: number;
  autoSend: boolean;
  lines: Array<{ description: string; quantity: number; unit: string; unitPrice: number; vatRate: number }>;
}

export interface RecurringCustomer {
  id: string;
  name: string;
  defaultPaymentTermDays?: number;
}

const EMPTY_LINE: RecurringFormLine = {
  description: "",
  quantity: "1",
  unit: "kpl",
  unitPrice: "",
  vatRate: 25.5,
};

/** A blank line; a seller who is not VAT registered starts at ALV 0 % (F01). */
export function newRecurringLine(vatRegistered = true): RecurringFormLine {
  return { ...EMPTY_LINE, vatRate: vatRegistered ? EMPTY_LINE.vatRate : 0 };
}

/**
 * The date the rates are checked against: the first invoice the schedule
 * makes. Each later run follows the rate change by itself (an old 14 % line
 * bills 13,5 % from 1.1.2026), so only the first date can be wrong.
 */
function firstInvoiceDate(values: RecurringFormValues): string {
  const anchorDay = Number(values.anchorDay);
  if (isStrictIsoDate(values.startDate) && Number.isInteger(anchorDay) && anchorDay >= 1 && anchorDay <= 31) {
    try {
      return firstRun({
        interval: values.interval,
        anchorDay,
        startDate: values.startDate,
        endDate: values.endDate || null,
      });
    } catch {
      // fall through to the start date
    }
  }
  return isStrictIsoDate(values.startDate) ? values.startDate : helsinkiCalendarDate();
}

/**
 * The rates the ALV select offers (permille); the line's own rate stays in
 * the list when it is no longer valid, so the select never shows another one.
 */
export function recurringVatOptions(currentRatePercent: number, values: RecurringFormValues): number[] {
  const offered: number[] = vatRatesForDate(firstInvoiceDate(values));
  const current = Math.round(currentRatePercent * 10);
  return offered.includes(current) ? offered : [...offered, current];
}

/** A blank schedule; the start date is today in Helsinki, not in UTC (SALES-33). */
export function emptyRecurringForm(vatRegistered = true): RecurringFormValues {
  return {
    customerId: "",
    name: "",
    interval: "monthly",
    anchorDay: "1",
    startDate: helsinkiCalendarDate(),
    endDate: "",
    paymentTermDays: "14",
    autoSend: false,
    lines: [newRecurringLine(vatRegistered)],
  };
}

/**
 * Every line is validated on its own (SALES-04): a line with a description
 * but no price is an error under that field, never silently dropped, because
 * a dropped line is lost revenue on every run of the schedule.
 */
export function validateRecurringForm(
  values: RecurringFormValues,
  options: { vatRegistered?: boolean } = {}
): { ok: true; payload: RecurringPayload } | { ok: false; errors: Record<string, string> } {
  const vatRegistered = options.vatRegistered ?? true;
  const errors: Record<string, string> = {};
  if (!values.customerId) errors.customerId = "Valitse asiakas.";
  const anchorDay = Number(values.anchorDay);
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    errors.anchorDay = "Laskutuspäivä on 1-31.";
  }
  if (!isStrictIsoDate(values.startDate)) errors.startDate = "Valitse alkupäivä.";
  if (values.endDate && values.endDate < values.startDate) {
    errors.endDate = "Päättymispäivä ei voi olla ennen alkupäivää.";
  }
  const term = Number(values.paymentTermDays);
  if (!values.paymentTermDays.trim() || !Number.isInteger(term) || term < 0 || term > 365) {
    errors.paymentTermDays = "Maksuaika on 0-365 päivää.";
  }

  const lines: RecurringPayload["lines"] = [];
  values.lines.forEach((line, index) => {
    const quantity = parseFinnishNumber(line.quantity);
    const unitPrice = parseMoneyInput(line.unitPrice);
    if (!line.description.trim()) errors[`line-${index}-description`] = "Kuvaus puuttuu.";
    if (quantity === null || quantity === 0) errors[`line-${index}-quantity`] = "Määrä puuttuu.";
    else if (quantity < 0) errors[`line-${index}-quantity`] = "Määrä ei voi olla negatiivinen.";
    if (!line.unitPrice.trim()) errors[`line-${index}-unitPrice`] = "Hinta puuttuu.";
    else if (unitPrice === null) errors[`line-${index}-unitPrice`] = "Hinta ei ole kelvollinen summa.";
    else if (unitPrice < 0) errors[`line-${index}-unitPrice`] = "Hinta ei voi olla negatiivinen.";
    if (vatRegistered) {
      try {
        applySellerVatRules([{ vatRatePermille: Math.round(line.vatRate * 10) }], {
          vatRegistered: true,
          issueDate: firstInvoiceDate(values),
        });
      } catch (error) {
        if (!(error instanceof InvoiceValidationError)) throw error;
        errors[`line-${index}-vatRate`] = error.message;
      }
    }
    if (line.description.trim() && quantity !== null && quantity > 0 && unitPrice !== null && unitPrice >= 0) {
      lines.push({
        description: line.description.trim(),
        quantity,
        unit: line.unit.trim() || "kpl",
        unitPrice,
        vatRate: vatRegistered ? line.vatRate : 0,
      });
    }
  });
  if (values.lines.length === 0) errors.lines = "Lisää vähintään yksi rivi.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      customerId: values.customerId,
      name: values.name.trim() || null,
      interval: values.interval,
      anchorDay,
      startDate: values.startDate,
      endDate: values.endDate || null,
      paymentTermDays: term,
      autoSend: values.autoSend,
      lines,
    },
  };
}

export function recurringFieldOrder(lineCount: number): string[] {
  const order = ["customerId", "anchorDay", "startDate", "endDate", "paymentTermDays"];
  for (let index = 0; index < lineCount; index += 1) {
    order.push(
      `line-${index}-description`,
      `line-${index}-quantity`,
      `line-${index}-unitPrice`,
      `line-${index}-vatRate`
    );
  }
  return order;
}

function fieldId(key: string): string {
  const ids: Record<string, string> = {
    customerId: "ri-customer",
    anchorDay: "ri-anchor",
    startDate: "ri-start",
    endDate: "ri-end",
    paymentTermDays: "ri-term",
  };
  if (ids[key]) return ids[key];
  const line = /^line-(\d+)-(description|quantity|unitPrice|vatRate)$/.exec(key);
  if (!line) return "ri-customer";
  const slot =
    line[2] === "description"
      ? "desc"
      : line[2] === "quantity"
        ? "qty"
        : line[2] === "vatRate"
          ? "vat"
          : "price";
  return `ri-line-${line[1]}-${slot}`;
}

export function RecurringForm({
  vatRegistered = true,
  customers,
  customersError,
  onRetryCustomers,
  initial,
  draftKey,
  submitLabel,
  busy,
  error,
  onAddCustomer,
  onSubmit,
  onCancel,
}: {
  /** A seller who is not VAT registered gets ALV 0 % and no ALV choice (F01). */
  vatRegistered?: boolean;
  customers: RecurringCustomer[] | null;
  customersError?: unknown;
  onRetryCustomers?: () => void;
  initial?: RecurringFormValues;
  draftKey: string;
  submitLabel: string;
  busy?: boolean;
  error?: string;
  onAddCustomer?: () => void;
  /** Resolves true when saved; the local draft is dropped only then. */
  onSubmit: (payload: RecurringPayload) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [baseline] = useState<RecurringFormValues>(() => {
    const start = initial ?? emptyRecurringForm(vatRegistered);
    // A template saved while the seller was registered shows the 0 % it will be saved with.
    return vatRegistered
      ? start
      : { ...start, lines: start.lines.map((line) => ({ ...line, vatRate: 0 })) };
  });
  const [values, setValues] = useState<RecurringFormValues>(baseline);
  const lineKeys = useLineKeys(values.lines.length);
  // The profile may arrive after the form was built (cached copy, then fresh): follow it.
  const [seenVatRegistered, setSeenVatRegistered] = useState(vatRegistered);
  if (seenVatRegistered !== vatRegistered) {
    setSeenVatRegistered(vatRegistered);
    setValues((current) => ({ ...current, lines: followSellerVat(current.lines, vatRegistered) }));
  }
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The draft survives an accidental close or an app switch (SALES-27), and
  // registers as dirty, so the sheet's swipe/backdrop close asks first.
  const session = useEditorSession({
    sourceId: draftKey,
    draftKey,
    baseline,
    value: values,
    onRestore: setValues,
  });

  function setLine(index: number, patch: Partial<RecurringFormLine>) {
    setValues((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  function pickCustomer(customerId: string) {
    const customer = customers?.find((entry) => entry.id === customerId);
    setValues((current) => ({
      ...current,
      customerId,
      // The customer's own payment term is the default (SALES-11).
      paymentTermDays:
        customer?.defaultPaymentTermDays !== undefined
          ? String(customer.defaultPaymentTermDays)
          : current.paymentTermDays,
    }));
  }

  const field = `${controlClass} min-h-12`;
  const label = "mb-1.5 block text-caption font-normal text-ink-2";
  const lineLabel = "mb-1.5 block text-caption font-normal text-ink-2";
  const errorText = (key: string, id: string) =>
    errors[key] ? (
      <p id={`${id}-error`} className="mt-1.5 text-caption text-danger" role="alert">
        {errors[key]}
      </p>
    ) : null;

  if (customers === null && customersError) {
    return (
      <ConnectionNotice
        compact
        error={customersError}
        fallback="Asiakkaiden haku epäonnistui"
        onRetry={onRetryCustomers}
      />
    );
  }

  if (customers !== null && customers.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-body text-ink-2">
          Toistuva lasku tarvitsee asiakkaan. Lisää asiakas, niin se valitaan tähän.
        </p>
        {onAddCustomer ? (
          <Button type="button" className="w-full" onClick={onAddCustomer}>
            Lisää asiakas
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateRecurringForm(values, { vatRegistered });
        if (!result.ok) {
          setErrors(result.errors);
          focusFirstInvalid(result.errors, recurringFieldOrder(values.lines.length), fieldId);
          return;
        }
        setErrors({});
        void onSubmit(result.payload).then((saved) => {
          if (saved) session.clearSavedDraft();
        });
      }}
    >
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <label className={label} htmlFor="ri-customer">Asiakas</label>
          {onAddCustomer ? (
            <button
              type="button"
              onClick={onAddCustomer}
              className={compactActionClass}
            >
              + Uusi asiakas
            </button>
          ) : null}
        </div>
        <CustomSelect
          className={field}
          value={values.customerId}
          onChange={(e) => pickCustomer(e.target.value)}
          disabled={customers === null}
          {...invalidFieldProps("ri-customer", errors.customerId)}
        >
          <option value="">{customers === null ? "Haetaan asiakkaita…" : "Valitse asiakas"}</option>
          {(customers ?? []).map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </CustomSelect>
        {errorText("customerId", "ri-customer")}
      </div>

      <div>
        <label className={label} htmlFor="ri-name">Nimi (valinnainen)</label>
        <input
          id="ri-name"
          className={field}
          value={values.name}
          onChange={(e) => setValues((current) => ({ ...current, name: e.target.value }))}
          placeholder="Esim. Kuukausihuolto"
          maxLength={120}
          autoCapitalize="sentences"
          autoComplete="off"
          enterKeyHint="next"
        />
      </div>

      <div className="field-grid">
        <div>
          <label className={label} htmlFor="ri-interval">Toistoväli</label>
          <CustomSelect
            id="ri-interval"
            className={field}
            value={values.interval}
            onChange={(e) =>
              setValues((current) => ({ ...current, interval: e.target.value as RecurrenceInterval }))
            }
          >
            {RECURRENCE_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>
                {INTERVAL_LABEL[interval]}
              </option>
            ))}
          </CustomSelect>
        </div>
        <div>
          <label className={label} htmlFor="ri-anchor">Laskutuspäivä</label>
          <input
            className={field}
            value={values.anchorDay}
            onChange={(e) => setValues((current) => ({ ...current, anchorDay: e.target.value }))}
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="next"
            {...invalidFieldProps("ri-anchor", errors.anchorDay, "ri-anchor-hint")}
          />
          {errors.anchorDay ? (
            errorText("anchorDay", "ri-anchor")
          ) : (
            <p id="ri-anchor-hint" className="mt-1.5 text-caption text-ink-2">
              31 tarkoittaa kuun viimeistä päivää lyhyissä kuukausissa.
            </p>
          )}
        </div>
      </div>

      <div className="field-dates">
        <div>
          <label className={label} htmlFor="ri-start">Alkaa</label>
          <input
            type="date"
            lang="fi"
            className={field}
            value={values.startDate}
            onChange={(e) => setValues((current) => ({ ...current, startDate: e.target.value }))}
            {...invalidFieldProps("ri-start", errors.startDate)}
          />
          {errorText("startDate", "ri-start")}
        </div>
        <div>
          <label className={label} htmlFor="ri-end">Päättyy (valinnainen)</label>
          <input
            type="date"
            lang="fi"
            className={field}
            value={values.endDate}
            onChange={(e) => setValues((current) => ({ ...current, endDate: e.target.value }))}
            {...invalidFieldProps("ri-end", errors.endDate)}
          />
          {errorText("endDate", "ri-end")}
        </div>
      </div>

      <div>
        <label className={label} htmlFor="ri-term">Maksuaika (pv)</label>
        <input
          className={field}
          value={values.paymentTermDays}
          onChange={(e) => setValues((current) => ({ ...current, paymentTermDays: e.target.value }))}
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="next"
          {...invalidFieldProps("ri-term", errors.paymentTermDays)}
        />
        {errorText("paymentTermDays", "ri-term")}
      </div>

      <div className="space-y-3">
        <p className="text-caption text-ink-2">Rivit</p>
        {!vatRegistered && (
          <p className="text-caption text-ink-2">
            Et ole ALV-rekisterissä, laskulle ei lisätä ALV:tä.
          </p>
        )}
        <AnimatedRows rows={values.lines.map((line, index) => ({ key: lineKeys.keys[index] ?? String(index), node: (
          <Card key={index} className="space-y-2">
            <label className={lineLabel} htmlFor={`ri-line-${index}-desc`}>Kuvaus</label>
            <input
              aria-label={`Rivin ${index + 1} kuvaus`}
              className={field}
              value={line.description}
              onChange={(e) => setLine(index, { description: e.target.value })}
              placeholder="Kuvaus"
              autoCapitalize="sentences"
              autoComplete="off"
              enterKeyHint="next"
              {...invalidFieldProps(`ri-line-${index}-desc`, errors[`line-${index}-description`])}
            />
            {errorText(`line-${index}-description`, `ri-line-${index}-desc`)}
            <div className="field-grid field-grid-3">
              <div>
                <label className={lineLabel} htmlFor={`ri-line-${index}-qty`}>Määrä</label>
                <input
                  aria-label={`Rivin ${index + 1} määrä`}
                  className={field}
                  value={line.quantity}
                  onChange={(e) => setLine(index, { quantity: e.target.value })}
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="next"
                  {...invalidFieldProps(`ri-line-${index}-qty`, errors[`line-${index}-quantity`])}
                />
                {errorText(`line-${index}-quantity`, `ri-line-${index}-qty`)}
              </div>
              <div>
                <label className={lineLabel} htmlFor={`ri-line-${index}-unit`}>Yksikkö</label>
                <input
                  id={`ri-line-${index}-unit`}
                  aria-label={`Rivin ${index + 1} yksikkö`}
                  className={field}
                  value={line.unit}
                  onChange={(e) => setLine(index, { unit: e.target.value })}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  enterKeyHint="next"
                />
              </div>
              <div>
                <label className={lineLabel} htmlFor={`ri-line-${index}-price`}>Hinta €</label>
                <input
                  aria-label={`Rivin ${index + 1} hinta`}
                  className={field}
                  value={line.unitPrice}
                  onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                  inputMode="decimal"
                  placeholder="0,00"
                  autoComplete="off"
                  enterKeyHint="next"
                  {...invalidFieldProps(`ri-line-${index}-price`, errors[`line-${index}-unitPrice`])}
                />
                {errorText(`line-${index}-unitPrice`, `ri-line-${index}-price`)}
              </div>
            </div>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                {vatRegistered ? (
                  <>
                    <label className={lineLabel} htmlFor={`ri-line-${index}-vat`}>ALV</label>
                    <CustomSelect
                      aria-label={`Rivin ${index + 1} ALV`}
                      className={field}
                      value={line.vatRate}
                      onChange={(e) => setLine(index, { vatRate: Number(e.target.value) })}
                      {...invalidFieldProps(`ri-line-${index}-vat`, errors[`line-${index}-vatRate`])}
                    >
                      {recurringVatOptions(line.vatRate, values).map((permille) => (
                        <option key={permille} value={permille / 10} data-short-label={vatRateLabel(permille)}>
                          {vatRateLabel(permille)}
                          {vatRateDateNote(permille, firstInvoiceDate(values))}
                        </option>
                      ))}
                    </CustomSelect>
                    {errorText(`line-${index}-vatRate`, `ri-line-${index}-vat`)}
                  </>
                ) : null}
              </div>
              {values.lines.length > 1 && (
                <Button
                  type="button"
                  variant="danger"
                  className="shrink-0"
                  onClick={() => {
                    lineKeys.remove(index);
                    setValues((current) => ({
                      ...current,
                      lines: current.lines.filter((_, i) => i !== index),
                    }));
                  }}
                >
                  Poista
                </Button>
              )}
            </div>
          </Card>
        ) }))} />
        <button
          type="button"
          className={compactActionClass}
          onClick={() => {
            lineKeys.add();
            setValues((current) => ({
              ...current,
              lines: [...current.lines, newRecurringLine(vatRegistered)],
            }));
          }}
        >
          + Lisää rivi
        </button>
        {errors.lines && (
          <p className="text-caption text-danger" role="alert">
            {errors.lines}
          </p>
        )}
      </div>

      <label className="flex min-h-11 items-center gap-3 text-body text-ink">
        <input
          type="checkbox"
          checked={values.autoSend}
          onChange={(e) => setValues((current) => ({ ...current, autoSend: e.target.checked }))}
          className="h-5 w-5 shrink-0"
        />
        Lähetä lasku asiakkaalle sähköpostilla heti kun se luodaan
      </label>

      {session.notice && (
        <p className="text-caption text-ink" role="status">
          {session.notice}
        </p>
      )}
      {error && (
        <p className="text-caption text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          onClick={() => session.requestCancel(onCancel)}
        >
          Peruuta
        </Button>
        <Button type="submit" className="flex-1" busy={busy} busyLabel="Tallennetaan…">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
