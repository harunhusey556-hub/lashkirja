"use client";

import { useState } from "react";
import { errorMessage } from "@/components/clientFetch";
import { useEditorSession } from "@/components/form-session";
import { Button, controlClass, SavePhaseNote } from "@/components/ui";
import { focusFirstInvalid, invalidFieldProps } from "@/lib/focus-field";
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

export function validateCustomerForm(
  values: CustomerFormValues
): { ok: true; payload: CustomerFormPayload } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!values.name.trim()) errors.name = "Anna asiakkaan nimi.";
  if (values.businessId.trim() && !isValidBusinessId(values.businessId)) {
    errors.businessId = "Y-tunnus ei täsmää (esim. 0201256-6).";
  }
  if (values.email.trim() && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(values.email.trim())) {
    errors.email = "Tarkista sähköpostiosoite.";
  }
  const term = Number(values.defaultPaymentTermDays);
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
  onCancel: () => void;
}

export function CustomerForm({
  initial,
  submitLabel,
  busy,
  draftKey = "customer:new",
  onReload,
  onSubmit,
  onCancel,
}: Props) {
  const [baseline] = useState<CustomerFormValues>({ ...EMPTY, ...initial });
  const [values, setValues] = useState<CustomerFormValues>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState("");
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
  const label = "mb-1.5 block text-caption font-normal text-ink-2";

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateCustomerForm(values);
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
          })
          .catch((error: unknown) => {
            session.setPhase("failed");
            setSaveError(errorMessage(error, "Tallennus epäonnistui"));
          });
      }}
    >
      <div className="space-y-1.5">
        <label className={label} htmlFor="cf-name">
          Nimi <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          className={field}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          aria-required="true"
          maxLength={120}
          autoCapitalize="words"
          autoComplete="organization"
          enterKeyHint="next"
          {...invalidFieldProps("cf-name", errors.name)}
        />
        {errors.name && (
          <p id="cf-name-error" className="text-sm text-danger" role="alert">
            {errors.name}
          </p>
        )}
      </div>

      <div className="field-grid">
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-business">Y-tunnus</label>
          <input
            className={field}
            value={values.businessId}
            onChange={(e) => set("businessId", e.target.value)}
            placeholder="0201256-6"
            maxLength={20}
            autoCapitalize="characters"
            autoComplete="off"
            enterKeyHint="next"
            {...invalidFieldProps("cf-business", errors.businessId)}
          />
          {errors.businessId && (
            <p id="cf-business-error" className="text-sm text-danger" role="alert">
              {errors.businessId}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-term">Maksuaika (pv)</label>
          <input
            className={field}
            value={values.defaultPaymentTermDays}
            onChange={(e) => set("defaultPaymentTermDays", e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="next"
            {...invalidFieldProps("cf-term", errors.defaultPaymentTermDays)}
          />
          {errors.defaultPaymentTermDays && (
            <p id="cf-term-error" className="text-sm text-danger" role="alert">
              {errors.defaultPaymentTermDays}
            </p>
          )}
        </div>
      </div>

      <div className="field-grid">
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-email">Sähköposti</label>
          <input
            className={field}
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="email"
            enterKeyHint="next"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={160}
            {...invalidFieldProps("cf-email", errors.email)}
          />
          {errors.email && (
            <p id="cf-email-error" className="text-sm text-danger" role="alert">
              {errors.email}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-phone">Puhelin</label>
          <input
            id="cf-phone"
            className={field}
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            enterKeyHint="next"
            maxLength={40}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className={label} htmlFor="cf-street">Osoite</label>
        <input
          id="cf-street"
          className={field}
          value={values.addressStreet}
          onChange={(e) => set("addressStreet", e.target.value)}
          maxLength={120}
          autoComplete="street-address"
          autoCapitalize="words"
          enterKeyHint="next"
        />
        <div className="field-grid field-grid-3 pt-1">
          <input
            aria-label="Postinumero"
            className={field}
            value={values.addressPostalCode}
            onChange={(e) => set("addressPostalCode", e.target.value)}
            placeholder="00100"
            maxLength={20}
            inputMode="numeric"
            autoComplete="postal-code"
            enterKeyHint="next"
          />
          <input
            aria-label="Postitoimipaikka"
            className={`${field} col-span-2`}
            value={values.addressCity}
            onChange={(e) => set("addressCity", e.target.value)}
            placeholder="Helsinki"
            maxLength={80}
            autoComplete="address-level2"
            autoCapitalize="words"
            enterKeyHint="next"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className={label} htmlFor="cf-notes">Muistiinpanot</label>
        <textarea
          id="cf-notes"
          className={`${controlClass} min-h-24`}
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
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
