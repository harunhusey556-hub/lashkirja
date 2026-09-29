"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { ErrorState } from "@/components/AsyncState";
import { Card, Skeleton, SkeletonCard, SkeletonGroup, useSkeletonFade } from "@/components/ds";
import { useEditorSession } from "@/components/form-session";
import { Button, Field, FormError, controlClass } from "@/components/ui";
import { focusFirstInvalid } from "@/lib/focus-field";
import { isValidBusinessId, normalizeBusinessId } from "@/lib/finnish-reference";
import { hapticNotify } from "@/lib/haptics";
import { formatIban, isValidIban, normalizeIban } from "@/lib/iban";
import { parseFinnishNumber } from "@/lib/format";
import { showToast } from "@/lib/toast";

interface SellerProfile {
  lateInterestPercent: number | null;
  reminderFeeCents: number;
  businessName: string | null;
  businessId: string | null;
  addressStreet: string | null;
  addressPostalCode: string | null;
  addressCity: string | null;
  phone: string | null;
  invoiceIban: string | null;
  invoiceBic: string | null;
  invoiceTerms: string | null;
}

type Values = Record<keyof SellerProfile, string>;

const EMPTY: Values = {
  lateInterestPercent: "",
  reminderFeeCents: "5,00",
  businessName: "",
  businessId: "",
  addressStreet: "",
  addressPostalCode: "",
  addressCity: "",
  phone: "",
  invoiceIban: "",
  invoiceBic: "",
  invoiceTerms: "",
};

/** Field order on screen, for focusing the first invalid one. */
const FIELD_ORDER = [
  "businessId",
  "addressPostalCode",
  "invoiceIban",
  "lateInterestPercent",
  "reminderFeeCents",
] as const;

const FIELD_ID: Record<string, string> = {
  businessId: "sp-business-id",
  addressPostalCode: "sp-postal",
  invoiceIban: "sp-iban",
  lateInterestPercent: "sp-interest",
  reminderFeeCents: "sp-fee",
};

function fromProfile(profile: Partial<SellerProfile>): Values {
  return {
    lateInterestPercent:
      profile.lateInterestPercent === null || profile.lateInterestPercent === undefined
        ? ""
        : String(profile.lateInterestPercent).replace(".", ","),
    reminderFeeCents: ((profile.reminderFeeCents ?? 500) / 100).toFixed(2).replace(".", ","),
    businessName: profile.businessName ?? "",
    businessId: profile.businessId ?? "",
    addressStreet: profile.addressStreet ?? "",
    addressPostalCode: profile.addressPostalCode ?? "",
    addressCity: profile.addressCity ?? "",
    phone: profile.phone ?? "",
    invoiceIban: profile.invoiceIban ? formatIban(profile.invoiceIban) : "",
    invoiceBic: profile.invoiceBic ?? "",
    invoiceTerms: profile.invoiceTerms ?? "",
  };
}

function SellerSkeleton() {
  return (
    <SkeletonGroup label="Ladataan laskuttajan tietoja">
      <SkeletonCard className="space-y-4">
        {[0, 1, 2, 3].map((row) => (
          <div key={row}>
            <Skeleton className="h-3 w-28" tone="soft" />
            <Skeleton className="mt-2 h-12 w-full" radius="card" />
          </div>
        ))}
        <Skeleton className="h-12 w-full" radius="card" />
      </SkeletonCard>
    </SkeletonGroup>
  );
}

/**
 * Seller details printed on every sales invoice. Kept separate from the
 * personal profile because these are what the customer and the tax authority
 * see, and an invoice missing them is not a valid invoice.
 *
 * The form is never shown before a successful load (AUTH-16): saving an empty
 * form would send nulls and wipe the seller data.
 */
export default function SellerProfileCard() {
  const [values, setValues] = useState<Values>(EMPTY);
  const [baseline, setBaseline] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const fade = useSkeletonFade(status === "loading");

  // AUTH-13: leaving with unsaved seller details asks first (Back, tabs).
  useEditorSession({
    sourceId: "seller-profile",
    draftKey: null,
    baseline,
    value: values,
    active: status === "ready",
    onRestore: () => {},
  });

  const load = useCallback(async () => {
    setStatus("loading");
    setLoadFailure(null);
    try {
      const response = await apiFetch("/api/profile", { credentials: "include" });
      const data = await readJson<{ profile: Partial<SellerProfile> }>(response, "Profiilin haku epäonnistui");
      const loaded = fromProfile(data.profile);
      setValues(loaded);
      setBaseline(loaded);
      setStatus("ready");
    } catch (error) {
      setLoadFailure(error);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  function set<K extends keyof Values>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: "" }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const nextErrors: Record<string, string> = {};
    if (values.businessId.trim() && !isValidBusinessId(values.businessId)) {
      nextErrors.businessId = "Y-tunnus ei täsmää (esim. 0201256-6).";
    }
    if (values.addressPostalCode.trim() && !/^\d{5}$/.test(values.addressPostalCode.trim())) {
      nextErrors.addressPostalCode = "Postinumerossa on 5 numeroa.";
    }
    if (values.invoiceIban.trim() && !isValidIban(values.invoiceIban)) {
      nextErrors.invoiceIban = "IBAN ei ole kelvollinen.";
    }
    const interest = values.lateInterestPercent.trim() ? parseFinnishNumber(values.lateInterestPercent) : null;
    if (values.lateInterestPercent.trim() && (interest === null || interest < 0 || interest > 100)) {
      nextErrors.lateInterestPercent = "Anna korko välillä 0-100, esim. 11,5.";
    }
    const fee = parseFinnishNumber(values.reminderFeeCents);
    if (fee === null || fee < 0) {
      nextErrors.reminderFeeCents = "Anna muistutusmaksu, esim. 5,00.";
    }
    setErrors(nextErrors);
    setFormError("");
    if (Object.keys(nextErrors).length > 0) {
      void hapticNotify("error");
      focusFirstInvalid(nextErrors, FIELD_ORDER, (key) => FIELD_ID[key] ?? key);
      return;
    }
    setSaving(true);

    try {
      const response = await apiFetch("/api/profile", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: values.businessName.trim() || null,
          businessId: values.businessId.trim() ? normalizeBusinessId(values.businessId) : null,
          addressStreet: values.addressStreet.trim() || null,
          addressPostalCode: values.addressPostalCode.trim() || null,
          addressCity: values.addressCity.trim() || null,
          phone: values.phone.trim() || null,
          invoiceIban: values.invoiceIban.trim() ? normalizeIban(values.invoiceIban) : null,
          invoiceBic: values.invoiceBic.trim().toUpperCase() || null,
          invoiceTerms: values.invoiceTerms.trim() || null,
          lateInterestPercent: interest,
          reminderFee: fee,
        }),
      });
      await readJson(response, "Tallennus epäonnistui");
      setBaseline(values);
      showToast({ tone: "success", text: "Laskuttajan tiedot tallennettu." });
    } catch (error) {
      void hapticNotify("error");
      setFormError(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setSaving(false);
    }
  }

  if (status === "error") {
    return <ErrorState error={loadFailure} message="Laskuttajan tietoja ei saatu ladattua" onRetry={() => void load()} />;
  }
  if (status === "loading") return <SellerSkeleton />;

  return (
    <Card className={`space-y-4 ${fade}`.trim()}>
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field label="Toiminimi tai yrityksen nimi" htmlFor="sp-name">
          <input
            id="sp-name"
            name="businessName"
            className={controlClass}
            value={values.businessName}
            onChange={(e) => set("businessName", e.target.value)}
            autoComplete="organization"
            autoCapitalize="words"
            enterKeyHint="next"
            placeholder="Liisan Ripsistudio"
          />
        </Field>

        <div className="field-grid">
          <Field label="Y-tunnus" htmlFor="sp-business-id" error={errors.businessId}>
            <input
              id="sp-business-id"
              name="businessId"
              className={`${controlClass}${errors.businessId ? " !border-danger" : ""}`}
              value={values.businessId}
              onChange={(e) => set("businessId", e.target.value)}
              inputMode="text"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={9}
              enterKeyHint="next"
              placeholder="0201256-6"
            />
          </Field>
          <Field label="Puhelin" htmlFor="sp-phone">
            <input
              id="sp-phone"
              name="phone"
              className={controlClass}
              value={values.phone}
              onChange={(e) => set("phone", e.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              enterKeyHint="next"
            />
          </Field>
        </div>

        <Field label="Katuosoite" htmlFor="sp-street">
          <input
            id="sp-street"
            name="addressStreet"
            className={controlClass}
            value={values.addressStreet}
            onChange={(e) => set("addressStreet", e.target.value)}
            autoComplete="address-line1"
            autoCapitalize="words"
            enterKeyHint="next"
          />
        </Field>
        <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3">
          <Field label="Postinumero" htmlFor="sp-postal" error={errors.addressPostalCode}>
            <input
              id="sp-postal"
              name="addressPostalCode"
              className={`${controlClass}${errors.addressPostalCode ? " !border-danger" : ""}`}
              value={values.addressPostalCode}
              onChange={(e) => set("addressPostalCode", e.target.value.replace(/\D/g, "").slice(0, 5))}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="postal-code"
              maxLength={5}
              enterKeyHint="next"
              placeholder="00100"
            />
          </Field>
          <Field label="Postitoimipaikka" htmlFor="sp-city">
            <input
              id="sp-city"
              name="addressCity"
              className={controlClass}
              value={values.addressCity}
              onChange={(e) => set("addressCity", e.target.value)}
              autoComplete="address-level2"
              autoCapitalize="words"
              enterKeyHint="next"
              placeholder="Helsinki"
            />
          </Field>
        </div>

        <Field
          label="Tilinumero (IBAN)"
          htmlFor="sp-iban"
          error={errors.invoiceIban}
          hint="IBAN tarvitaan myös laskun viivakoodiin."
        >
          <input
            id="sp-iban"
            name="invoiceIban"
            className={`${controlClass}${errors.invoiceIban ? " !border-danger" : ""}`}
            value={values.invoiceIban}
            onChange={(e) => set("invoiceIban", e.target.value)}
            onBlur={(e) => set("invoiceIban", formatIban(e.target.value))}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            placeholder="FI21 1234 5600 0007 85"
          />
        </Field>
        <Field label="BIC" htmlFor="sp-bic">
          <input
            id="sp-bic"
            name="invoiceBic"
            className={controlClass}
            value={values.invoiceBic}
            onChange={(e) => set("invoiceBic", e.target.value.toUpperCase())}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            placeholder="NDEAFIHH"
          />
        </Field>

        <div className="field-grid">
          <Field
            label="Viivästyskorko (% / v)"
            htmlFor="sp-interest"
            error={errors.lateInterestPercent}
            hint="Suomen Pankin viitekorko + 7 (kuluttaja) tai + 8 (yritys) prosenttiyksikköä. Tyhjä = korkoa ei peritä."
          >
            <input
              id="sp-interest"
              name="lateInterestPercent"
              className={`${controlClass}${errors.lateInterestPercent ? " !border-danger" : ""}`}
              value={values.lateInterestPercent}
              onChange={(e) => set("lateInterestPercent", e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="next"
              placeholder="11,5"
            />
          </Field>
          <Field label="Muistutusmaksu (€)" htmlFor="sp-fee" error={errors.reminderFeeCents}>
            <input
              id="sp-fee"
              name="reminderFeeCents"
              className={`${controlClass}${errors.reminderFeeCents ? " !border-danger" : ""}`}
              value={values.reminderFeeCents}
              onChange={(e) => set("reminderFeeCents", e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="next"
            />
          </Field>
        </div>

        <Field label="Laskun ehdot" htmlFor="sp-terms">
          <textarea
            id="sp-terms"
            name="invoiceTerms"
            className={`${controlClass} min-h-24`}
            value={values.invoiceTerms}
            onChange={(e) => set("invoiceTerms", e.target.value)}
            placeholder="Viivästyskorko 8 %. Huomautusaika 8 päivää."
          />
        </Field>

        <FormError message={formError} />
        <Button type="submit" className="w-full" busy={saving} busyLabel="Tallennetaan…">
          Tallenna laskuttajan tiedot
        </Button>
      </form>
    </Card>
  );
}
