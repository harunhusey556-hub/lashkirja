"use client";

import { useState } from "react";
import { errorMessage } from "@/components/clientFetch";
import { useEditorSession } from "@/components/form-session";
import { Button, controlClass, Field, SavePhaseNote } from "@/components/ui";
import { focusFirstInvalid } from "@/lib/focus-field";
import { isValidBusinessId, normalizeBusinessId } from "@/lib/finnish-reference";

export interface CustomerFormValues {
  name: string;
  businessId: string;
  contactPerson: string;
  email: string;
  phone: string;
  addressStreet: string;
  addressPostalCode: string;
  addressCity: string;
  defaultPaymentTermDays: string;
  notes: string;
}

export type CustomerFormPayload = Omit<CustomerFormValues, "defaultPaymentTermDays"> & {
  defaultPaymentTermDays: number;
};

const EMPTY: CustomerFormValues = {
  name: "",
  businessId: "",
  contactPerson: "",
  email: "",
  phone: "",
  addressStreet: "",
  addressPostalCode: "",
  addressCity: "",
  defaultPaymentTermDays: "14",
  notes: "",
};

/** The term a customer gets when the field is left empty. */
export const DEFAULT_PAYMENT_TERM_DAYS = 14;

/**
 * `blankTermDays` is what an emptied "Maksuaika" field means: the term the
 * customer already had, or the default 14 for a new one. It is never 0 by
 * accident, and the text is checked as typed ("1e2" or "0x10" are not days).
 */
export function validateCustomerForm(
  values: CustomerFormValues,
  blankTermDays: number = DEFAULT_PAYMENT_TERM_DAYS
): { ok: true; payload: CustomerFormPayload } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!values.name.trim()) errors.name = "Anna asiakkaan nimi.";
  if (values.businessId.trim() && !isValidBusinessId(values.businessId)) {
    errors.businessId = "Y-tunnus ei täsmää (esim. 0201256-6).";
  }
  if (values.email.trim() && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(values.email.trim())) {
    errors.email = "Tarkista sähköpostiosoite.";
  }
  const termText = values.defaultPaymentTermDays.trim();
  const term = termText === "" ? blankTermDays : /^\d{1,3}$/.test(termText) ? Number(termText) : NaN;
  if (!Number.isInteger(term) || term < 0 || term > 365) {
    errors.defaultPaymentTermDays = "Maksuaika on 0-365 päivää.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      name: values.name.trim(),
      businessId: values.businessId.trim() ? normalizeBusinessId(values.businessId) : "",
      contactPerson: values.contactPerson.trim(),
      email: values.email.trim(),
      phone: values.phone.trim(),
      addressStreet: values.addressStreet.trim(),
      addressPostalCode: values.addressPostalCode.trim(),
      addressCity: values.addressCity.trim(),
      defaultPaymentTermDays: term,
      notes: values.notes.trim(),
    },
  };
}

export const CUSTOMER_FIELD_ORDER = ["name", "businessId", "email", "defaultPaymentTermDays"] as const;

export function customerFieldId(key: string): string {
  if (key === "name") return "cf-name";
  if (key === "businessId") return "cf-business";
  if (key === "email") return "cf-email";
  if (key === "defaultPaymentTermDays") return "cf-term";
  return key;
}

interface Props {
  initial?: Partial<CustomerFormValues>;
  submitLabel: string;
  busy?: boolean;
  draftKey?: string;
  onReload?: () => void;
  onSubmit: (payload: CustomerFormPayload) => void | Promise<void>;
  /**
   * Called once the save went through and the form's own draft is gone. The
   * parent closes the sheet here, never before: a form unmounted while its
   * draft is still stored writes the draft back (F40).
   */
  onSaved?: () => void;
  onCancel: () => void;
}

export function CustomerForm({
  initial,
  submitLabel,
  busy,
  draftKey = "customer:new",
  onReload,
  onSubmit,
  onSaved,
  onCancel,
}: Props) {
  const [baseline] = useState<CustomerFormValues>({ ...EMPTY, ...initial });
  const [values, setValues] = useState<CustomerFormValues>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState("");
  // An emptied term field keeps what the customer had (14 for a new customer).
  const [blankTermDays] = useState(() => {
    const had = baseline.defaultPaymentTermDays.trim();
    return /^\d{1,3}$/.test(had) && Number(had) <= 365 ? Number(had) : DEFAULT_PAYMENT_TERM_DAYS;
  });
  const session = useEditorSession({
    sourceId: draftKey,
    draftKey,
    baseline,
    value: values,
    onRestore: setValues,
  });

  function set<K extends keyof CustomerFormValues>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const field = `${controlClass} min-h-12`;

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateCustomerForm(values, blankTermDays);
        if (!result.ok) {
          setErrors(result.errors);
          setSaveError("");
          focusFirstInvalid(result.errors, CUSTOMER_FIELD_ORDER, customerFieldId);
          return;
        }
        setErrors({});
        setSaveError("");
        session.setPhase("saving");
        void Promise.resolve(onSubmit(result.payload))
          .then(() => {
            session.clearSavedDraft();
            session.setPhase("saved");
            onSaved?.();
          })
          .catch((error: unknown) => {
            session.setPhase("failed");
            setSaveError(errorMessage(error, "Tallennus epäonnistui"));
          });
      }}
    >
      <Field label="Nimi" htmlFor="cf-name" error={errors.name}>
        <input
          className={field}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          aria-required="true"
          maxLength={120}
          autoCapitalize="words"
          autoComplete="off"
          enterKeyHint="next"
        />
      </Field>

      <div className="field-grid">
        <Field label="Y-tunnus" htmlFor="cf-business" error={errors.businessId} optional>
          <input
            className={field}
            value={values.businessId}
            onChange={(e) => set("businessId", e.target.value)}
            placeholder="0201256-6"
            maxLength={20}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
          />
        </Field>
        <Field label="Maksuaika (pv)" htmlFor="cf-term" error={errors.defaultPaymentTermDays}>
          <input
            className={field}
            placeholder={String(blankTermDays)}
            value={values.defaultPaymentTermDays}
            onChange={(e) => set("defaultPaymentTermDays", e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="next"
          />
        </Field>
      </div>

      <div className="field-grid">
        <Field
          label="Sähköposti"
          htmlFor="cf-email"
          error={errors.email}
          optional
          hint="Tarvitaan laskun lähetykseen."
        >
          <input
            className={field}
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="off"
            enterKeyHint="next"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={160}
          />
        </Field>
        <Field label="Puhelin" htmlFor="cf-phone" optional>
          <input
            className={field}
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            enterKeyHint="next"
            maxLength={40}
          />
        </Field>
      </div>

      <Field label="Katuosoite" htmlFor="cf-street" optional>
        <input
          className={field}
          value={values.addressStreet}
          onChange={(e) => set("addressStreet", e.target.value)}
          maxLength={120}
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="next"
        />
      </Field>
      <div className="field-grid field-grid-3">
        <Field label="Postinumero" htmlFor="cf-postal" optional>
          <input
            className={field}
            value={values.addressPostalCode}
            onChange={(e) => set("addressPostalCode", e.target.value)}
            placeholder="00100"
            maxLength={20}
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="next"
          />
        </Field>
        <div className="col-span-2">
          <Field label="Postitoimipaikka" htmlFor="cf-city" optional>
            <input
              className={field}
              value={values.addressCity}
              onChange={(e) => set("addressCity", e.target.value)}
              placeholder="Helsinki"
              maxLength={80}
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="next"
            />
          </Field>
        </div>
      </div>

      <Field label="Muistiinpanot" htmlFor="cf-notes" optional>
        <textarea
          className={`${controlClass} min-h-24`}
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
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
      {saveError.includes("Lataa tiedot uudelleen") && onReload && (
        <Button type="button" variant="secondary" onClick={onReload}>
          Lataa uudelleen
        </Button>
      )}
      <div className="flex gap-3 pt-1">
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          onClick={() => session.requestCancel(onCancel)}
        >
          Peruuta
        </Button>
        <Button
          type="submit"
          className="flex-1"
          busy={busy || session.phase === "saving"}
          busyLabel="Tallennetaan…"
          disabledReason={busy ? "Tallennus on kesken." : undefined}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
