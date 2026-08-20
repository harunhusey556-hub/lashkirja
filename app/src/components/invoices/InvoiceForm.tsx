"use client";

import { useMemo, useState } from "react";
import { formatEur, parseFinnishNumber } from "@/lib/format";
import {
  computeInvoiceTotals,
  InvoiceValidationError,
  VAT_RATES_PERMILLE,
} from "@/lib/invoices";

export interface InvoiceFormLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: number; // percent
}

export interface InvoiceFormValues {
  customerId: string;
  issueDate: string;
  dueDate: string;
  notes: string;
  lines: InvoiceFormLine[];
}

export interface InvoicePayload {
  customerId: string;
  issueDate: string;
  dueDate: string;
  notes: string | null;
  lines: Array<{
    description: string;
    quantity: number;
    unit: string;
    unitPrice: number;
    vatRate: number;
  }>;
}

export const EMPTY_LINE: InvoiceFormLine = {
  description: "",
  quantity: "1",
  unit: "kpl",
  unitPrice: "",
  vatRate: 25.5,
};

export function validateInvoiceForm(
  values: InvoiceFormValues
): { ok: true; payload: InvoicePayload } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!values.customerId) errors.customerId = "Valitse asiakas.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.issueDate)) errors.issueDate = "Valitse laskun päivä.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.dueDate)) errors.dueDate = "Valitse eräpäivä.";
  if (values.issueDate && values.dueDate && values.dueDate < values.issueDate) {
    errors.dueDate = "Eräpäivä ei voi olla ennen laskun päivää.";
  }

  const lines: InvoicePayload["lines"] = [];
  values.lines.forEach((line, index) => {
    const quantity = parseFinnishNumber(line.quantity);
    const unitPrice = parseFinnishNumber(line.unitPrice);
    if (!line.description.trim()) errors[`line-${index}-description`] = "Kuvaus puuttuu.";
    if (quantity === null || quantity === 0) errors[`line-${index}-quantity`] = "Määrä puuttuu.";
    if (unitPrice === null) errors[`line-${index}-unitPrice`] = "Hinta puuttuu.";
    if (quantity !== null && unitPrice !== null && line.description.trim()) {
      lines.push({
        description: line.description.trim(),
        quantity,
        unit: line.unit.trim() || "kpl",
        unitPrice,
        vatRate: line.vatRate,
      });
    }
  });
  if (lines.length === 0) errors.lines = "Lisää vähintään yksi rivi.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      customerId: values.customerId,
      issueDate: values.issueDate,
      dueDate: values.dueDate,
      notes: values.notes.trim() || null,
      lines,
    },
  };
}

/** Live totals while typing; invalid rows are simply skipped. */
export function previewTotals(lines: InvoiceFormLine[]) {
  const parsed = lines
    .map((line) => {
      const quantity = parseFinnishNumber(line.quantity);
      const unitPrice = parseFinnishNumber(line.unitPrice);
      if (quantity === null || quantity === 0 || unitPrice === null) return null;
      return {
        quantityMilli: Math.round(quantity * 1000),
        unitPriceCents: Math.round(unitPrice * 100),
        vatRatePermille: Math.round(line.vatRate * 10),
      };
    })
    .filter((line): line is NonNullable<typeof line> => line !== null);

  if (parsed.length === 0) return { netCents: 0, vatCents: 0, grossCents: 0 };
  try {
    const totals = computeInvoiceTotals(parsed);
    return { netCents: totals.netCents, vatCents: totals.vatCents, grossCents: totals.grossCents };
  } catch (error) {
    if (error instanceof InvoiceValidationError) {
      return { netCents: 0, vatCents: 0, grossCents: 0 };
    }
    throw error;
  }
}

interface Props {
  customers: Array<{ id: string; name: string; defaultPaymentTermDays: number }>;
  initial?: Partial<InvoiceFormValues>;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (payload: InvoicePayload) => void | Promise<void>;
  onCancel: () => void;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function InvoiceForm({ customers, initial, submitLabel, busy, onSubmit, onCancel }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [values, setValues] = useState<InvoiceFormValues>({
    customerId: customers[0]?.id ?? "",
    issueDate: today,
    dueDate: addDays(today, customers[0]?.defaultPaymentTermDays ?? 14),
    notes: "",
    lines: [{ ...EMPTY_LINE }],
    ...initial,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const totals = useMemo(() => previewTotals(values.lines), [values.lines]);

  function setLine(index: number, patch: Partial<InvoiceFormLine>) {
    setValues((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  function pickCustomer(customerId: string) {
    const customer = customers.find((entry) => entry.id === customerId);
    setValues((current) => ({
      ...current,
      customerId,
      // Following the customer's own term is the expected default.
      dueDate: customer ? addDays(current.issueDate, customer.defaultPaymentTermDays) : current.dueDate,
    }));
  }

  const field = "w-full px-3 py-2.5 rounded-xl border border-warm-gray-light/60 bg-white text-sm";
  const label = "text-sm font-medium text-charcoal";

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateInvoiceForm(values);
        if (!result.ok) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        void onSubmit(result.payload);
      }}
    >
      <div className="space-y-1.5">
        <label className={label} htmlFor="if-customer">Asiakas</label>
        <select
          id="if-customer"
          className={field}
          value={values.customerId}
          onChange={(e) => pickCustomer(e.target.value)}
          aria-invalid={Boolean(errors.customerId)}
        >
          <option value="">Valitse asiakas</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        {errors.customerId && <p className="text-xs text-danger">{errors.customerId}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className={label} htmlFor="if-issue">Laskun päivä</label>
          <input
            id="if-issue"
            type="date"
            className={field}
            value={values.issueDate}
            onChange={(e) =>
              setValues((current) => ({ ...current, issueDate: e.target.value }))
            }
          />
          {errors.issueDate && <p className="text-xs text-danger">{errors.issueDate}</p>}
        </div>
        <div className="space-y-1.5">
          <label className={label} htmlFor="if-due">Eräpäivä</label>
          <input
            id="if-due"
            type="date"
            className={field}
            value={values.dueDate}
            onChange={(e) => setValues((current) => ({ ...current, dueDate: e.target.value }))}
          />
          {errors.dueDate && <p className="text-xs text-danger">{errors.dueDate}</p>}
        </div>
      </div>

      <div className="space-y-3">
        <p className={label}>Rivit</p>
        {values.lines.map((line, index) => (
          <div
            key={index}
            className="rounded-2xl border border-warm-gray-light/40 p-3 space-y-2 bg-cream/40"
          >
            <input
              aria-label={`Rivin ${index + 1} kuvaus`}
              className={field}
              value={line.description}
              onChange={(e) => setLine(index, { description: e.target.value })}
              placeholder="Ripsienpidennys"
            />
            <div className="grid grid-cols-3 gap-2">
              <input
                aria-label={`Rivin ${index + 1} määrä`}
                className={field}
                value={line.quantity}
                onChange={(e) => setLine(index, { quantity: e.target.value })}
                inputMode="decimal"
              />
              <input
                aria-label={`Rivin ${index + 1} yksikkö`}
                className={field}
                value={line.unit}
                onChange={(e) => setLine(index, { unit: e.target.value })}
              />
              <input
                aria-label={`Rivin ${index + 1} hinta`}
                className={field}
                value={line.unitPrice}
                onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                inputMode="decimal"
                placeholder="€"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label={`Rivin ${index + 1} ALV`}
                className={`${field} flex-1`}
                value={line.vatRate}
                onChange={(e) => setLine(index, { vatRate: Number(e.target.value) })}
              >
                {VAT_RATES_PERMILLE.map((permille) => (
                  <option key={permille} value={permille / 10}>
                    ALV {permille / 10} %
                  </option>
                ))}
              </select>
              {values.lines.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setValues((current) => ({
                      ...current,
                      lines: current.lines.filter((_, i) => i !== index),
                    }))
                  }
                  className="px-3 py-2 rounded-xl border border-danger/40 text-danger text-xs"
                >
                  Poista
                </button>
              )}
            </div>
            {(errors[`line-${index}-description`] ||
              errors[`line-${index}-quantity`] ||
              errors[`line-${index}-unitPrice`]) && (
              <p className="text-xs text-danger">
                {errors[`line-${index}-description`] ||
                  errors[`line-${index}-quantity`] ||
                  errors[`line-${index}-unitPrice`]}
              </p>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={() =>
            setValues((current) => ({ ...current, lines: [...current.lines, { ...EMPTY_LINE }] }))
          }
          className="w-full py-2.5 rounded-2xl border border-warm-gray-light/60 text-sm font-medium"
        >
          Lisää rivi
        </button>
        {errors.lines && <p className="text-xs text-danger">{errors.lines}</p>}
      </div>

      <div className="rounded-2xl bg-white border border-warm-gray-light/30 p-4 space-y-1 text-sm">
        <div className="flex justify-between text-warm-gray">
          <span>Veroton</span>
          <span>{formatEur(totals.netCents / 100)}</span>
        </div>
        <div className="flex justify-between text-warm-gray">
          <span>ALV</span>
          <span>{formatEur(totals.vatCents / 100)}</span>
        </div>
        <div className="flex justify-between font-semibold text-charcoal pt-1">
          <span>Yhteensä</span>
          <span>{formatEur(totals.grossCents / 100)}</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className={label} htmlFor="if-notes">Viesti laskulla</label>
        <textarea
          id="if-notes"
          className={`${field} min-h-[64px]`}
          value={values.notes}
          onChange={(e) => setValues((current) => ({ ...current, notes: e.target.value }))}
        />
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-3 rounded-2xl border border-warm-gray-light/60 text-sm font-medium"
        >
          Peruuta
        </button>
        <button
          type="submit"
          disabled={busy}
          className="flex-1 py-3 rounded-2xl bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-50"
        >
          {busy ? "Tallennetaan…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
