"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditorSession } from "@/components/form-session";
import { Button, controlClass, SavePhaseNote } from "@/components/ui";
import { BottomActions, Card, Section } from "@/components/ds";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { focusFirstInvalid, invalidFieldProps } from "@/lib/focus-field";
import { formatEur, parseFinnishNumber, parseMoneyInput } from "@/lib/format";
import {
  computeInvoiceTotals,
  InvoiceValidationError,
  VAT_RATES_PERMILLE,
} from "@/lib/invoices";
import { helsinkiCalendarDate, isStrictIsoDate } from "@/lib/validation";

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
  if (!isStrictIsoDate(values.issueDate)) errors.issueDate = "Valitse laskun päivä.";
  if (!isStrictIsoDate(values.dueDate)) errors.dueDate = "Valitse eräpäivä.";
  if (
    isStrictIsoDate(values.issueDate) &&
    isStrictIsoDate(values.dueDate) &&
    values.dueDate < values.issueDate
  ) {
    errors.dueDate = "Eräpäivä ei voi olla ennen laskun päivää.";
  }

  const lines: InvoicePayload["lines"] = [];
  values.lines.forEach((line, index) => {
    const quantity = parseFinnishNumber(line.quantity);
    const unitPrice = parseMoneyInput(line.unitPrice);
    if (!line.description.trim()) errors[`line-${index}-description`] = "Kuvaus puuttuu.";
    if (quantity === null || quantity === 0) errors[`line-${index}-quantity`] = "Määrä puuttuu.";
    else if (quantity < 0) errors[`line-${index}-quantity`] = "Määrä ei voi olla negatiivinen.";
    if (!line.unitPrice.trim()) errors[`line-${index}-unitPrice`] = "Hinta puuttuu.";
    else if (unitPrice === null) errors[`line-${index}-unitPrice`] = "Hinta ei ole kelvollinen summa.";
    else if (unitPrice < 0) errors[`line-${index}-unitPrice`] = "Hinta ei voi olla negatiivinen.";
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

export function invoiceFieldOrder(lineCount: number): string[] {
  const order = ["customerId", "issueDate", "dueDate"];
  for (let index = 0; index < lineCount; index += 1) {
    order.push(
      `line-${index}-description`,
      `line-${index}-quantity`,
      `line-${index}-unitPrice`
    );
  }
  order.push("lines");
  return order;
}

export function invoiceFieldId(key: string): string {
  if (key === "customerId") return "if-customer";
  if (key === "issueDate") return "if-issue";
  if (key === "dueDate") return "if-due";
  const line = /^line-(\d+)-(description|quantity|unitPrice)$/.exec(key);
  if (!line) return "if-customer";
  const slot = line[2] === "description" ? "desc" : line[2] === "quantity" ? "qty" : "price";
  return `if-line-${line[1]}-${slot}`;
}

interface Props {
  customers: Array<{ id: string; name: string; defaultPaymentTermDays: number }>;
  initial?: Partial<InvoiceFormValues>;
  submitLabel: string;
  busy?: boolean;
  draftKey?: string;
  /** Opens an inline "Uusi asiakas" sheet; the page selects the new customer via `selectCustomerId`. */
  onAddCustomer?: () => void;
  /** A customer the page just created; selected (with its payment term) once it is in `customers`. */
  selectCustomerId?: string;
  onSubmit: (payload: InvoicePayload) => void | Promise<void>;
  onCancel: () => void;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function InvoiceForm({
  customers,
  initial,
  submitLabel,
  busy,
  draftKey = "invoice:new",
  onAddCustomer,
  selectCustomerId,
  onSubmit,
  onCancel,
}: Props) {
  const today = helsinkiCalendarDate();
  const [baseline] = useState<InvoiceFormValues>(() => {
    // No silent default customer (SALES-08): a hurried "Luo lasku" must not
    // bill the first name in the list. A preset customer brings its own term.
    const preset = customers.find((customer) => customer.id === initial?.customerId);
    const issueDate = initial?.issueDate ?? today;
    return {
      customerId: "",
      issueDate,
      dueDate: addDays(issueDate, preset?.defaultPaymentTermDays ?? 14),
      notes: "",
      lines: [{ ...EMPTY_LINE }],
      ...initial,
    };
  });
  const [values, setValues] = useState<InvoiceFormValues>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState("");
  const [catalog, setCatalog] = useState<
    Array<{ id: string; name: string; unit: string; unitPrice: number; vatRate: number }>
  >([]);
  const session = useEditorSession({
    sourceId: draftKey,
    draftKey,
    baseline,
    value: values,
    onRestore: setValues,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch("/api/catalog", { credentials: "include" });
        const data = await readJson<{
          items: Array<{ id: string; name: string; unit: string; unitPrice: number; vatRate: number }>;
        }>(response, "Tuotteiden haku epäonnistui");
        if (!cancelled) setCatalog(data.items);
      } catch {
        // The invoice form still works when the catalog cannot be loaded.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => previewTotals(values.lines), [values.lines]);

  async function saveLineAsProduct(index: number) {
    const line = values.lines[index];
    if (!line) return;
    const unitPrice = parseMoneyInput(line.unitPrice);
    if (!line.description.trim() || unitPrice === null || unitPrice < 0) {
      setSaveError("Tallenna tuotteeksi vasta kun kuvaus ja hinta ovat kunnossa.");
      return;
    }
    try {
      const response = await apiFetch("/api/catalog", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: line.description.trim(),
          unit: line.unit.trim() || "kpl",
          unitPrice,
          vatRate: line.vatRate,
        }),
      });
      const data = await readJson<{
        item: { id: string; name: string; unit: string; unitPrice: number; vatRate: number };
      }>(response, "Tuotteen tallennus epäonnistui");
      setCatalog((current) => [...current, data.item].sort((a, b) => a.name.localeCompare(b.name, "fi")));
      setSaveError("");
    } catch (error) {
      setSaveError(errorMessage(error, "Tuotteen tallennus epäonnistui"));
    }
  }

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
    if (customerId) {
      setErrors((current) => {
        const next = { ...current };
        delete next.customerId;
        return next;
      });
    }
  }

  // A customer created in the inline sheet is selected as soon as it is in the list.
  const [selectedExternal, setSelectedExternal] = useState<string | undefined>(undefined);
  if (
    selectCustomerId &&
    selectCustomerId !== selectedExternal &&
    customers.some((customer) => customer.id === selectCustomerId)
  ) {
    setSelectedExternal(selectCustomerId);
    pickCustomer(selectCustomerId);
  }

  const field = controlClass;
  const label = "mb-1.5 block text-[13px] text-ink-2";
  const lineLabel = "mb-1 block text-[13px] text-ink-2";

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateInvoiceForm(values);
        if (!result.ok) {
          setErrors(result.errors);
          setSaveError("");
          focusFirstInvalid(result.errors, invoiceFieldOrder(values.lines.length), invoiceFieldId);
          return;
        }
        setErrors({});
        setSaveError("");
        session.setPhase("saving");
        void Promise.resolve(onSubmit(result.payload))
          .then(() => {
            session.clearSavedDraft();
            session.setPhase("saved");
          })
          .catch((error: unknown) => {
            session.setPhase("failed");
            setSaveError(errorMessage(error, "Tallennus epäonnistui"));
          });
      }}
    >
      <Section>
        <div className="space-y-1.5 px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <label className={label} htmlFor="if-customer">
              Asiakas <span className="text-danger" aria-hidden="true">*</span>
            </label>
            {onAddCustomer ? (
              <button
                type="button"
                onClick={onAddCustomer}
                className="relative text-[13px] font-medium text-accent before:absolute before:-inset-x-2 before:-inset-y-[14px] before:content-['']"
              >
                Uusi asiakas
              </button>
            ) : null}
          </div>
          <select
            className={field}
            value={values.customerId}
            onChange={(e) => pickCustomer(e.target.value)}
            aria-required="true"
            {...invalidFieldProps("if-customer", errors.customerId)}
          >
            <option value="">Valitse asiakas</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
          {errors.customerId && (
            <p id="if-customer-error" className="text-xs text-danger" role="alert">
              {errors.customerId}
            </p>
          )}
        </div>

        <div className="field-dates px-4 py-3">
          <div className="space-y-1.5">
            <label className={label} htmlFor="if-issue">
              Laskun päivä <span className="text-danger" aria-hidden="true">*</span>
            </label>
            <input
              type="date"
              className={field}
              value={values.issueDate}
              onChange={(e) =>
                setValues((current) => ({ ...current, issueDate: e.target.value }))
              }
              aria-required="true"
              {...invalidFieldProps("if-issue", errors.issueDate)}
            />
            {errors.issueDate && (
              <p id="if-issue-error" className="text-xs text-danger" role="alert">
                {errors.issueDate}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className={label} htmlFor="if-due">
              Eräpäivä <span className="text-danger" aria-hidden="true">*</span>
            </label>
            <input
              type="date"
              className={field}
              value={values.dueDate}
              onChange={(e) => setValues((current) => ({ ...current, dueDate: e.target.value }))}
              aria-required="true"
              {...invalidFieldProps("if-due", errors.dueDate)}
            />
            {errors.dueDate && (
              <p id="if-due-error" className="text-xs text-danger" role="alert">
                {errors.dueDate}
              </p>
            )}
          </div>
        </div>
      </Section>

      <div>
        <p className="mb-2 px-1 text-[13px] text-ink-2">Rivit</p>
        <div className="space-y-3">
          {values.lines.map((line, index) => (
            <Card key={index} className="space-y-2">
              {catalog.length > 0 && (
                <div>
                  <label className={lineLabel} htmlFor={`if-line-${index}-product`}>
                    Tuote
                  </label>
                  <select
                    id={`if-line-${index}-product`}
                    className={field}
                    value=""
                    onChange={(event) => {
                      const item = catalog.find((entry) => entry.id === event.target.value);
                      if (!item) return;
                      setLine(index, {
                        description: item.name,
                        unit: item.unit,
                        unitPrice: String(item.unitPrice).replace(".", ","),
                        vatRate: item.vatRate,
                      });
                    }}
                  >
                    <option value="">Valitse tuote</option>
                    {catalog.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <label className={lineLabel} htmlFor={`if-line-${index}-desc`}>
                Kuvaus <span className="text-danger" aria-hidden="true">*</span>
              </label>
              <input
                aria-required="true"
                aria-label={`Rivin ${index + 1} kuvaus (pakollinen)`}
                className={field}
                value={line.description}
                onChange={(e) => setLine(index, { description: e.target.value })}
                placeholder="Kuvaus"
                autoCapitalize="sentences"
                autoComplete="off"
                enterKeyHint="next"
                maxLength={200}
                {...invalidFieldProps(`if-line-${index}-desc`, errors[`line-${index}-description`])}
              />
              {errors[`line-${index}-description`] && (
                <p id={`if-line-${index}-desc-error`} className="text-xs text-danger" role="alert">
                  {errors[`line-${index}-description`]}
                </p>
              )}
              <div className="field-grid field-grid-3">
                <div>
                  <label className={lineLabel} htmlFor={`if-line-${index}-qty`}>
                    Määrä <span className="text-danger" aria-hidden="true">*</span>
                  </label>
                  <input
                    aria-required="true"
                    aria-label={`Rivin ${index + 1} määrä (pakollinen)`}
                    className={field}
                    value={line.quantity}
                    onChange={(e) => setLine(index, { quantity: e.target.value })}
                    inputMode="decimal"
                    autoComplete="off"
                    enterKeyHint="next"
                    {...invalidFieldProps(`if-line-${index}-qty`, errors[`line-${index}-quantity`])}
                  />
                  {errors[`line-${index}-quantity`] && (
                    <p id={`if-line-${index}-qty-error`} className="text-xs text-danger" role="alert">
                      {errors[`line-${index}-quantity`]}
                    </p>
                  )}
                </div>
                <div>
                  <label className={lineLabel} htmlFor={`if-line-${index}-unit`}>Yksikkö</label>
                  <input
                    id={`if-line-${index}-unit`}
                    aria-label={`Rivin ${index + 1} yksikkö`}
                    className={field}
                    value={line.unit}
                    onChange={(e) => setLine(index, { unit: e.target.value })}
                    maxLength={16}
                    autoCapitalize="none"
                    autoComplete="off"
                    enterKeyHint="next"
                  />
                </div>
                <div>
                  <label className={lineLabel} htmlFor={`if-line-${index}-price`}>
                    Hinta € <span className="text-danger" aria-hidden="true">*</span>
                  </label>
                  <input
                    aria-required="true"
                    aria-label={`Rivin ${index + 1} hinta (pakollinen)`}
                    className={field}
                    value={line.unitPrice}
                    onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                    inputMode="decimal"
                    placeholder="0,00"
                    autoComplete="off"
                    enterKeyHint="next"
                    {...invalidFieldProps(`if-line-${index}-price`, errors[`line-${index}-unitPrice`])}
                  />
                  {errors[`line-${index}-unitPrice`] && (
                    <p id={`if-line-${index}-price-error`} className="text-xs text-danger" role="alert">
                      {errors[`line-${index}-unitPrice`]}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label className={lineLabel} htmlFor={`if-line-${index}-vat`}>ALV</label>
                  <select
                    id={`if-line-${index}-vat`}
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
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => void saveLineAsProduct(index)}
                >
                  Tallenna tuotteeksi
                </Button>
                {values.lines.length > 1 && (
                  <Button
                    type="button"
                    variant="danger"
                    className="shrink-0"
                    onClick={() =>
                      setValues((current) => ({
                        ...current,
                        lines: current.lines.filter((_, i) => i !== index),
                      }))
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
            onClick={() =>
              setValues((current) => ({ ...current, lines: [...current.lines, { ...EMPTY_LINE }] }))
            }
          >
            Lisää rivi
          </Button>
          {errors.lines && <p className="text-xs text-danger">{errors.lines}</p>}
        </div>
      </div>

      <Card className="space-y-1 text-[15px]">
        <div className="flex justify-between text-ink-2">
          <span>Veroton</span>
          <span>{formatEur(totals.netCents / 100)}</span>
        </div>
        <div className="flex justify-between text-ink-2">
          <span>ALV</span>
          <span>{formatEur(totals.vatCents / 100)}</span>
        </div>
        <div className="flex justify-between pt-1 font-semibold text-ink">
          <span>Yhteensä</span>
          <span>{formatEur(totals.grossCents / 100)}</span>
        </div>
        {totals.grossCents === 0 && values.lines.some((line) => line.unitPrice.trim() === "") && (
          <p className="pt-2 text-xs text-ink-2">
            Summa päivittyy, kun rivillä on hinta. Tyhjä kenttä ei ole nolla euroa.
          </p>
        )}
      </Card>

      <div className="space-y-1.5">
        <label className={label} htmlFor="if-notes">Viesti laskulla</label>
        <textarea
          id="if-notes"
          className={`${controlClass} min-h-24`}
          value={values.notes}
          onChange={(e) => setValues((current) => ({ ...current, notes: e.target.value }))}
          maxLength={2000}
          autoCapitalize="sentences"
        />
      </div>

      {session.notice && (
        <p className="text-sm text-ink" role="status">
          {session.notice}{" "}
          <button
            type="button"
            className="font-medium text-accent underline"
            onClick={() => session.setNotice("")}
          >
            Sulje
          </button>{" "}
          <button
            type="button"
            className="font-medium text-accent underline"
            onClick={() => {
              session.clearSavedDraft();
              setValues(baseline);
            }}
          >
            Hylkää luonnos
          </button>
        </p>
      )}
      <SavePhaseNote phase={session.phase} error={saveError} />

      <BottomActions>
        <Button
          type="submit"
          className="w-full"
          busy={busy || session.phase === "saving"}
          busyLabel="Tallennetaan…"
          disabled={customers.length === 0}
          disabledReason={customers.length === 0 ? "Lisää ensin asiakas." : undefined}
        >
          {submitLabel}
        </Button>
        <button
          type="button"
          className="active-press flex min-h-12 w-full items-center justify-center text-[15px] font-semibold text-accent"
          onClick={() => session.requestCancel(onCancel)}
        >
          Peruuta
        </button>
      </BottomActions>
    </form>
  );
}
