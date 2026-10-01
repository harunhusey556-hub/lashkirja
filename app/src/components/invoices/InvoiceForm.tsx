"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditorSession } from "@/components/form-session";
import { Button, controlClass, Field, SavePhaseNote } from "@/components/ui";
import { BottomActions, Card, Section } from "@/components/ds";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { focusFirstInvalid } from "@/lib/focus-field";
import { formatEur, parseFinnishNumber, parseMoneyInput } from "@/lib/format";
import {
  adjustVatRateForDate,
  applySellerVatRules,
  computeInvoiceTotals,
  InvoiceValidationError,
  vatRateLabel,
  vatRatesForDate,
} from "@/lib/invoices";
import { helsinkiCalendarDate, isStrictIsoDate } from "@/lib/validation";
import { tintedButtonClass } from "@/components/control-styles";

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

/** A blank line; a seller who is not VAT registered starts at ALV 0 % (F01). */
export function newInvoiceLine(vatRegistered = true): InvoiceFormLine {
  return { ...EMPTY_LINE, vatRate: vatRegistered ? EMPTY_LINE.vatRate : 0 };
}

/**
 * The suffix for a rate the select still lists although it is not valid on the
 * invoice date: a rate that has ended says so, one that has not started says
 * so (13,5 % before 1.1.2026 is not "no longer in use").
 */
export function vatRateDateNote(ratePermille: number, issueDate: string): string {
  const date = isStrictIsoDate(issueDate) ? issueDate : helsinkiCalendarDate();
  if ((vatRatesForDate(date) as readonly number[]).includes(ratePermille)) return "";
  if (ratePermille === 140) return " (ei enää käytössä)";
  if (ratePermille === 135) return " (ei vielä käytössä)";
  return " (ei käytössä tälle päivälle)";
}

/**
 * The seller's VAT status can change after a form was built from a cached
 * profile. Lines follow it: 0 % everywhere when not registered; when the seller
 * turns out to be registered, a 0 % line that only the unregistered state forced
 * goes back to the default rate, so a registered seller never issues 0 % by accident.
 */
export function followSellerVat<T extends { vatRate: number }>(lines: T[], vatRegistered: boolean): T[] {
  return lines.map((line) => {
    if (vatRegistered) return line.vatRate === 0 ? { ...line, vatRate: EMPTY_LINE.vatRate } : line;
    return line.vatRate === 0 ? line : { ...line, vatRate: 0 };
  });
}

/**
 * The rates the ALV select offers for an invoice dated `issueDate`, as
 * permille. The line's own rate stays in the list when it is no longer valid
 * (a 14 % draft moved into 2026), so the select shows the truth and the
 * validation error says what to pick instead.
 */
export function vatRateOptions(currentRatePercent: number, issueDate: string): number[] {
  const offered: number[] = vatRatesForDate(
    isStrictIsoDate(issueDate) ? issueDate : helsinkiCalendarDate()
  );
  const current = Math.round(currentRatePercent * 10);
  return offered.includes(current) ? offered : [...offered, current];
}

export function validateInvoiceForm(
  values: InvoiceFormValues,
  options: { vatRegistered?: boolean } = {}
): { ok: true; payload: InvoicePayload } | { ok: false; errors: Record<string, string> } {
  const vatRegistered = options.vatRegistered ?? true;
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
    if (vatRegistered && isStrictIsoDate(values.issueDate)) {
      try {
        applySellerVatRules([{ vatRatePermille: Math.round(line.vatRate * 10) }], {
          vatRegistered: true,
          issueDate: values.issueDate,
        });
      } catch (error) {
        if (!(error instanceof InvoiceValidationError)) throw error;
        errors[`line-${index}-vatRate`] = error.message;
      }
    }
    if (quantity !== null && unitPrice !== null && line.description.trim()) {
      lines.push({
        description: line.description.trim(),
        quantity,
        unit: line.unit.trim() || "kpl",
        unitPrice,
        vatRate: vatRegistered ? line.vatRate : 0,
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
export function previewTotals(
  lines: InvoiceFormLine[],
  options: { vatRegistered?: boolean } = {}
) {
  const vatRegistered = options.vatRegistered ?? true;
  const parsed = lines
    .map((line) => {
      const quantity = parseFinnishNumber(line.quantity);
      const unitPrice = parseFinnishNumber(line.unitPrice);
      if (quantity === null || quantity === 0 || unitPrice === null) return null;
      return {
        quantityMilli: Math.round(quantity * 1000),
        unitPriceCents: Math.round(unitPrice * 100),
        vatRatePermille: vatRegistered ? Math.round(line.vatRate * 10) : 0,
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
      `line-${index}-unitPrice`,
      `line-${index}-vatRate`
    );
  }
  order.push("lines");
  return order;
}

export function invoiceFieldId(key: string): string {
  if (key === "customerId") return "if-customer";
  if (key === "issueDate") return "if-issue";
  if (key === "dueDate") return "if-due";
  const line = /^line-(\d+)-(description|quantity|unitPrice|vatRate)$/.exec(key);
  if (!line) return "if-customer";
  const slot =
    line[2] === "description"
      ? "desc"
      : line[2] === "quantity"
        ? "qty"
        : line[2] === "vatRate"
          ? "vat"
          : "price";
  return `if-line-${line[1]}-${slot}`;
}

interface Props {
  customers: Array<{ id: string; name: string; defaultPaymentTermDays: number }>;
  initial?: Partial<InvoiceFormValues>;
  submitLabel: string;
  busy?: boolean;
  draftKey?: string;
  /**
   * Whether the seller is VAT registered. A seller who is not gets ALV 0 % on
   * every line and no ALV choice (F01); the server enforces the same.
   */
  vatRegistered?: boolean;
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
  vatRegistered = true,
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
    const start: InvoiceFormValues = {
      customerId: "",
      issueDate,
      dueDate: addDays(issueDate, preset?.defaultPaymentTermDays ?? 14),
      notes: "",
      lines: [newInvoiceLine(vatRegistered)],
      ...initial,
    };
    // A draft saved while the seller was registered shows the 0 % it will be saved with.
    return vatRegistered
      ? start
      : { ...start, lines: start.lines.map((line) => ({ ...line, vatRate: 0 })) };
  });
  const [values, setValues] = useState<InvoiceFormValues>(baseline);
  // The profile may arrive after the form was built (cached copy, then fresh): follow it.
  const [seenVatRegistered, setSeenVatRegistered] = useState(vatRegistered);
  if (seenVatRegistered !== vatRegistered) {
    setSeenVatRegistered(vatRegistered);
    setValues((current) => ({ ...current, lines: followSellerVat(current.lines, vatRegistered) }));
  }
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

  const totals = useMemo(
    () => previewTotals(values.lines, { vatRegistered }),
    [values.lines, vatRegistered]
  );

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
          vatRate: vatRegistered ? line.vatRate : 0,
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

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateInvoiceForm(values, { vatRegistered });
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
        <div className="px-4 py-3">
          <Field
            label="Asiakas"
            htmlFor="if-customer"
            error={errors.customerId}
          >
            <select
              className={field}
              value={values.customerId}
              onChange={(e) => pickCustomer(e.target.value)}
              aria-required="true"
              autoComplete="off"
            >
              <option value="">Valitse asiakas</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </Field>
          {onAddCustomer ? (
            <button
              type="button"
              onClick={onAddCustomer}
              className={tintedButtonClass("accent", "mt-1")}
            >
              Uusi asiakas
            </button>
          ) : null}
        </div>

        <div className="field-dates px-4 py-3">
          <Field label="Laskun päivä" htmlFor="if-issue" error={errors.issueDate}>
            <input
              type="date"
              lang="fi"
              className={field}
              value={values.issueDate}
              onChange={(e) =>
                setValues((current) => ({ ...current, issueDate: e.target.value }))
              }
              aria-required="true"
              autoComplete="off"
              enterKeyHint="next"
            />
          </Field>
          <Field label="Eräpäivä" htmlFor="if-due" error={errors.dueDate}>
            <input
              type="date"
              lang="fi"
              className={field}
              value={values.dueDate}
              onChange={(e) => setValues((current) => ({ ...current, dueDate: e.target.value }))}
              aria-required="true"
              autoComplete="off"
              enterKeyHint="next"
            />
          </Field>
        </div>
      </Section>

      <div>
        <p className="mb-2 px-1 text-caption text-ink-2">Rivit</p>
        {!vatRegistered && (
          <p className="mb-2 px-1 text-caption text-ink-2">
            Et ole ALV-rekisterissä, laskulle ei lisätä ALV:tä.
          </p>
        )}
        <div className="space-y-3">
          {values.lines.map((line, index) => (
            <Card key={index} className="space-y-3">
              {catalog.length > 0 && (
                <Field label="Tuote" htmlFor={`if-line-${index}-product`} optional>
                  <select
                    className={field}
                    value=""
                    autoComplete="off"
                    onChange={(event) => {
                      const item = catalog.find((entry) => entry.id === event.target.value);
                      if (!item) return;
                      setLine(index, {
                        description: item.name,
                        unit: item.unit,
                        unitPrice: String(item.unitPrice).replace(".", ","),
                        vatRate: vatRegistered
                          ? adjustVatRateForDate(Math.round(item.vatRate * 10), values.issueDate) / 10
                          : 0,
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
                </Field>
              )}
              <Field
                label="Kuvaus"
                htmlFor={`if-line-${index}-desc`}
                error={errors[`line-${index}-description`]}
              >
                <input
                  aria-required="true"
                  aria-label={`Rivin ${index + 1} kuvaus`}
                  className={field}
                  value={line.description}
                  onChange={(e) => setLine(index, { description: e.target.value })}
                  placeholder="Kuvaus"
                  autoCapitalize="sentences"
                  autoComplete="off"
                  enterKeyHint="next"
                  maxLength={200}
                />
              </Field>
              <div className="field-grid field-grid-3">
                <Field
                  label="Määrä"
                  htmlFor={`if-line-${index}-qty`}
                  error={errors[`line-${index}-quantity`]}
                >
                  <input
                    aria-required="true"
                    aria-label={`Rivin ${index + 1} määrä`}
                    className={field}
                    value={line.quantity}
                    onChange={(e) => setLine(index, { quantity: e.target.value })}
                    inputMode="decimal"
                    autoComplete="off"
                    enterKeyHint="next"
                  />
                </Field>
                <Field label="Yksikkö" htmlFor={`if-line-${index}-unit`}>
                  <input
                    aria-label={`Rivin ${index + 1} yksikkö`}
                    className={field}
                    value={line.unit}
                    onChange={(e) => setLine(index, { unit: e.target.value })}
                    maxLength={16}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="next"
                  />
                </Field>
                <Field
                  label="Hinta €"
                  htmlFor={`if-line-${index}-price`}
                  error={errors[`line-${index}-unitPrice`]}
                >
                  <input
                    aria-required="true"
                    aria-label={`Rivin ${index + 1} hinta`}
                    className={field}
                    value={line.unitPrice}
                    onChange={(e) => setLine(index, { unitPrice: e.target.value })}
                    inputMode="decimal"
                    placeholder="0,00"
                    autoComplete="off"
                    enterKeyHint="next"
                  />
                </Field>
              </div>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  {vatRegistered ? (
                    <Field
                      label="ALV"
                      htmlFor={`if-line-${index}-vat`}
                      error={errors[`line-${index}-vatRate`]}
                    >
                      <select
                        aria-label={`Rivin ${index + 1} ALV`}
                        className={field}
                        value={line.vatRate}
                        autoComplete="off"
                        onChange={(e) => setLine(index, { vatRate: Number(e.target.value) })}
                      >
                        {vatRateOptions(line.vatRate, values.issueDate).map((permille) => (
                          <option key={permille} value={permille / 10}>
                            {vatRateLabel(permille)}
                            {vatRateDateNote(permille, values.issueDate)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
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
              setValues((current) => ({
                ...current,
                lines: [...current.lines, newInvoiceLine(vatRegistered)],
              }))
            }
          >
            Lisää rivi
          </Button>
          {errors.lines && <p className="text-caption text-danger">{errors.lines}</p>}
        </div>
      </div>

      <Card className="space-y-1 text-body">
        {vatRegistered && (
          <>
            <div className="flex justify-between text-ink-2">
              <span>Veroton</span>
              <span className="tabular-nums">{formatEur(totals.netCents / 100)}</span>
            </div>
            <div className="flex justify-between text-ink-2">
              <span>ALV</span>
              <span className="tabular-nums">{formatEur(totals.vatCents / 100)}</span>
            </div>
          </>
        )}
        <div className="flex justify-between pt-1 font-semibold text-ink">
          <span>Yhteensä</span>
          <span className="tabular-nums">{formatEur(totals.grossCents / 100)}</span>
        </div>
        {totals.grossCents === 0 && values.lines.some((line) => line.unitPrice.trim() === "") && (
          <p className="pt-2 text-caption text-ink-2">
            Summa päivittyy, kun rivillä on hinta. Tyhjä kenttä ei ole nolla euroa.
          </p>
        )}
      </Card>

      <Field label="Viesti laskulla" htmlFor="if-notes" optional>
        <textarea
          className={`${controlClass} min-h-24`}
          value={values.notes}
          onChange={(e) => setValues((current) => ({ ...current, notes: e.target.value }))}
          maxLength={2000}
          autoCapitalize="sentences"
        />
      </Field>

      {session.notice && (
        <p className="text-caption text-ink" role="status">
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
        <button
          type="button"
          className="active-press flex min-h-12 w-full items-center justify-center rounded-card bg-accent-soft text-body font-semibold text-accent"
          onClick={() => session.requestCancel(onCancel)}
        >
          Peruuta
        </button>
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
      </BottomActions>
    </form>
  );
}
