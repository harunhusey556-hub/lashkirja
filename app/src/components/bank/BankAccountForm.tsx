"use client";

import { useState } from "react";
import { Button, controlClass } from "@/components/ui";
import { bankNameFromIban, formatIban, isValidIban, normalizeIban } from "@/lib/iban";
import { parseFinnishNumber } from "@/lib/format";

export interface BankAccountFormValues {
  name: string;
  bankName: string;
  iban: string;
  bic: string;
  currency: string;
  openingBalance: string;
  openingDate: string;
}

export interface BankAccountFormPayload {
  name: string;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  currency: string;
  openingBalance: number;
  openingDate: string;
}

const EMPTY: BankAccountFormValues = {
  name: "",
  bankName: "",
  iban: "",
  bic: "",
  currency: "EUR",
  openingBalance: "0",
  openingDate: new Date().toISOString().slice(0, 10),
};

/** Client-side mirror of the server rules, so mistakes surface before saving. */
export function validateBankAccountForm(
  values: BankAccountFormValues
): { ok: true; payload: BankAccountFormPayload } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const name = values.name.trim();
  if (!name) errors.name = "Anna tilille nimi.";
  else if (name.length > 80) errors.name = "Nimi on liian pitkä (max 80 merkkiä).";

  const iban = normalizeIban(values.iban);
  if (iban && !isValidIban(iban)) errors.iban = "IBAN ei ole kelvollinen.";

  const openingBalance = parseFinnishNumber(values.openingBalance);
  if (openingBalance === null) errors.openingBalance = "Anna summa, esim. 1250,50.";
  else if (Math.round(openingBalance * 100) !== openingBalance * 100) {
    errors.openingBalance = "Enintään kaksi desimaalia.";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.openingDate)) {
    errors.openingDate = "Valitse avauspäivä.";
  }

  const currency = values.currency.trim().toUpperCase();
  if (currency.length !== 3) errors.currency = "Valuutta on kolme kirjainta (esim. EUR).";

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      name,
      bankName: values.bankName.trim() || null,
      iban: iban || null,
      bic: values.bic.trim().toUpperCase() || null,
      currency,
      openingBalance: openingBalance as number,
      openingDate: values.openingDate,
    },
  };
}

interface Props {
  initial?: Partial<BankAccountFormValues>;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (payload: BankAccountFormPayload) => void | Promise<void>;
  onCancel: () => void;
}

export function BankAccountForm({ initial, submitLabel, busy, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<BankAccountFormValues>({ ...EMPTY, ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function set<K extends keyof BankAccountFormValues>(key: K, value: string) {
    setValues((current) => {
      const next = { ...current, [key]: value } as BankAccountFormValues;
      // Filling the bank in from the IBAN saves a step; an entry the user
      // typed themselves is never overwritten.
      if (key === "iban" && !current.bankName.trim()) {
        const guess = bankNameFromIban(value);
        if (guess) next.bankName = guess;
      }
      return next;
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = validateBankAccountForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    void onSubmit(result.payload);
  }

  const field = `${controlClass} min-h-12`;
  const label = "mb-1.5 block text-[13px] font-normal text-ink-2";
  const errorText = "mt-1.5 text-sm text-danger";

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label className={label} htmlFor="ba-name">
          Tilin nimi <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id="ba-name"
          enterKeyHint="next"
          className={field}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Käyttötili"
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "ba-name-error" : undefined}
          aria-required="true"
          maxLength={80}
        />
        {errors.name && <p id="ba-name-error" className={errorText} role="alert">{errors.name}</p>}
      </div>

      <div>
        <label className={label} htmlFor="ba-iban">IBAN</label>
        <input
          id="ba-iban"
          enterKeyHint="next"
          className={field}
          value={values.iban}
          onChange={(e) => set("iban", e.target.value)}
          onBlur={(e) => set("iban", formatIban(e.target.value))}
          placeholder="FI21 1234 5600 0007 85"
          inputMode="text"
          autoCapitalize="characters"
          aria-invalid={Boolean(errors.iban)}
          aria-describedby={errors.iban ? "ba-iban-error" : undefined}
          maxLength={42}
        />
        {errors.iban ? (
          <p id="ba-iban-error" className={errorText} role="alert">{errors.iban}</p>
        ) : (
          <p className="text-xs text-ink-2">Vapaaehtoinen – käteiskassalla ei ole IBANia.</p>
        )}
      </div>

      <div className="field-grid">
        <div>
          <label className={label} htmlFor="ba-bank">Pankki</label>
          <input
            id="ba-bank"
            enterKeyHint="next"
            className={field}
            value={values.bankName}
            onChange={(e) => set("bankName", e.target.value)}
            placeholder="Nordea"
            maxLength={80}
          />
        </div>
        <div>
          <label className={label} htmlFor="ba-currency">
            Valuutta <span className="text-danger" aria-hidden="true">*</span>
          </label>
          <input
            id="ba-currency"
            enterKeyHint="next"
            className={field}
            value={values.currency}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
            maxLength={3}
            aria-invalid={Boolean(errors.currency) || undefined}
            aria-describedby={errors.currency ? "ba-currency-error" : undefined}
            aria-required="true"
          />
          {errors.currency && (
            <p id="ba-currency-error" className={errorText} role="alert">
              {errors.currency}
            </p>
          )}
        </div>
      </div>

      <div className="field-dates">
        <div>
          <label className={label} htmlFor="ba-opening">
            Alkusaldo (€) <span className="text-danger" aria-hidden="true">*</span>
          </label>
          <input
            id="ba-opening"
            enterKeyHint="next"
            className={field}
            value={values.openingBalance}
            onChange={(e) => set("openingBalance", e.target.value)}
            inputMode="decimal"
            aria-invalid={Boolean(errors.openingBalance)}
            aria-describedby={errors.openingBalance ? "ba-opening-error" : undefined}
            aria-required="true"
          />
          {errors.openingBalance && (
            <p id="ba-opening-error" className={errorText} role="alert">{errors.openingBalance}</p>
          )}
        </div>
        <div>
          <label className={label} htmlFor="ba-date">
            Avauspäivä <span className="text-danger" aria-hidden="true">*</span>
          </label>
          <input
            id="ba-date"
            type="date"
            className={field}
            value={values.openingDate}
            onChange={(e) => set("openingDate", e.target.value)}
            aria-invalid={Boolean(errors.openingDate) || undefined}
            aria-describedby={errors.openingDate ? "ba-date-error" : undefined}
            aria-required="true"
          />
          {errors.openingDate && (
            <p id="ba-date-error" className={errorText} role="alert">
              {errors.openingDate}
            </p>
          )}
        </div>
      </div>

      <p className="text-xs text-ink-2 leading-relaxed">
        Alkusaldo on tilin saldo avauspäivän aamuna. Sitä aiemmat tapahtumat jäävät laskennan
        ulkopuolelle.
      </p>

      <div className="flex gap-3 pt-1">
        <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
          Peruuta
        </Button>
        <Button type="submit" className="flex-1" busy={busy} busyLabel="Tallennetaan…">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
