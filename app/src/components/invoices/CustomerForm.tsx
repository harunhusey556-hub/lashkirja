"use client";

import { useState } from "react";
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

interface Props {
  initial?: Partial<CustomerFormValues>;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (payload: CustomerFormPayload) => void | Promise<void>;
  onCancel: () => void;
}

export function CustomerForm({ initial, submitLabel, busy, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<CustomerFormValues>({ ...EMPTY, ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});

  function set<K extends keyof CustomerFormValues>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  const field = "w-full px-4 py-3 rounded-xl border border-warm-gray-light/60 bg-white text-sm";
  const label = "text-sm font-medium text-charcoal";

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = validateCustomerForm(values);
        if (!result.ok) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        void onSubmit(result.payload);
      }}
    >
      <div className="space-y-1.5">
        <label className={label} htmlFor="cf-name">Nimi</label>
        <input
          id="cf-name"
          className={field}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          aria-invalid={Boolean(errors.name)}
        />
        {errors.name && <p className="text-xs text-danger">{errors.name}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-business">Y-tunnus</label>
          <input
            id="cf-business"
            className={field}
            value={values.businessId}
            onChange={(e) => set("businessId", e.target.value)}
            placeholder="0201256-6"
            aria-invalid={Boolean(errors.businessId)}
          />
          {errors.businessId && <p className="text-xs text-danger">{errors.businessId}</p>}
        </div>
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-term">Maksuaika (pv)</label>
          <input
            id="cf-term"
            className={field}
            value={values.defaultPaymentTermDays}
            onChange={(e) => set("defaultPaymentTermDays", e.target.value)}
            inputMode="numeric"
            aria-invalid={Boolean(errors.defaultPaymentTermDays)}
          />
          {errors.defaultPaymentTermDays && (
            <p className="text-xs text-danger">{errors.defaultPaymentTermDays}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-email">Sähköposti</label>
          <input
            id="cf-email"
            className={field}
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            inputMode="email"
            aria-invalid={Boolean(errors.email)}
          />
          {errors.email && <p className="text-xs text-danger">{errors.email}</p>}
        </div>
        <div className="space-y-1.5">
          <label className={label} htmlFor="cf-phone">Puhelin</label>
          <input
            id="cf-phone"
            className={field}
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            inputMode="tel"
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
        />
        <div className="grid grid-cols-3 gap-3 pt-1">
          <input
            aria-label="Postinumero"
            className={field}
            value={values.addressPostalCode}
            onChange={(e) => set("addressPostalCode", e.target.value)}
            placeholder="00100"
          />
          <input
            aria-label="Postitoimipaikka"
            className={`${field} col-span-2`}
            value={values.addressCity}
            onChange={(e) => set("addressCity", e.target.value)}
            placeholder="Helsinki"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className={label} htmlFor="cf-notes">Muistiinpanot</label>
        <textarea
          id="cf-notes"
          className={`${field} min-h-[72px]`}
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </div>

      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-3 rounded-2xl border border-warm-gray-light/60 text-sm font-medium text-charcoal"
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
