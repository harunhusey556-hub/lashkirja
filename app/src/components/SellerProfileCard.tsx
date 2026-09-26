"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { isValidBusinessId, normalizeBusinessId } from "@/lib/finnish-reference";
import { formatIban, isValidIban, normalizeIban } from "@/lib/iban";
import { parseFinnishNumber } from "@/lib/format";

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

/**
 * Seller details printed on every sales invoice. Kept separate from the
 * personal profile because these are what the customer and the tax authority
 * see, and an invoice missing them is not a valid invoice.
 */
export default function SellerProfileCard() {
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/profile", { credentials: "include" });
      const data = await readJson<{ profile: Partial<SellerProfile> }>(
        response,
        "Profiilin haku epäonnistui"
      );
      setValues({
        lateInterestPercent:
          data.profile.lateInterestPercent === null ||
          data.profile.lateInterestPercent === undefined
            ? ""
            : String(data.profile.lateInterestPercent).replace(".", ","),
        reminderFeeCents: ((data.profile.reminderFeeCents ?? 500) / 100)
          .toFixed(2)
          .replace(".", ","),
        businessName: data.profile.businessName ?? "",
        businessId: data.profile.businessId ?? "",
        addressStreet: data.profile.addressStreet ?? "",
        addressPostalCode: data.profile.addressPostalCode ?? "",
        addressCity: data.profile.addressCity ?? "",
        phone: data.profile.phone ?? "",
        invoiceIban: data.profile.invoiceIban ? formatIban(data.profile.invoiceIban) : "",
        invoiceBic: data.profile.invoiceBic ?? "",
        invoiceTerms: data.profile.invoiceTerms ?? "",
      });
      setStatus("ready");
    } catch (error) {
      setMessage(errorMessage(error, "Profiilin haku epäonnistui"));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  function set<K extends keyof Values>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (values.businessId.trim() && !isValidBusinessId(values.businessId)) {
      nextErrors.businessId = "Y-tunnus ei täsmää (esim. 0201256-6).";
    }
    if (values.invoiceIban.trim() && !isValidIban(values.invoiceIban)) {
      nextErrors.invoiceIban = "IBAN ei ole kelvollinen.";
    }
    const interest = values.lateInterestPercent.trim()
      ? parseFinnishNumber(values.lateInterestPercent)
      : null;
    if (values.lateInterestPercent.trim() && (interest === null || interest < 0 || interest > 100)) {
      nextErrors.lateInterestPercent = "Anna korko välillä 0-100, esim. 11,5.";
    }
    const fee = parseFinnishNumber(values.reminderFeeCents);
    if (fee === null || fee < 0) {
      nextErrors.reminderFeeCents = "Anna muistutusmaksu, esim. 5,00.";
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setSaving(true);
    setMessage(null);

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
      setMessage("Laskuttajan tiedot tallennettu.");
    } catch (error) {
      setMessage(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full px-3 py-2.5 rounded-xl border border-warm-gray-light/60 bg-white text-sm";
  const label = "text-sm font-medium text-charcoal";

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
      <div>
        <h3 className="text-lg font-medium text-charcoal">Laskuttajan tiedot</h3>
        <p className="text-sm text-warm-gray mt-1">
          Nämä tulostuvat myyntilaskuille. IBAN tarvitaan myös viivakoodiin.
        </p>
      </div>

      {status === "loading" ? (
        <p className="text-sm text-warm-gray">Haetaan…</p>
      ) : (
        <form onSubmit={save} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label className={label} htmlFor="sp-name">Toiminimi tai yrityksen nimi</label>
            <input
              id="sp-name"
              className={field}
              value={values.businessName}
              onChange={(e) => set("businessName", e.target.value)}
              placeholder="Liisan Ripsistudio"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={label} htmlFor="sp-business-id">Y-tunnus</label>
              <input
                id="sp-business-id"
                className={field}
                value={values.businessId}
                onChange={(e) => set("businessId", e.target.value)}
                placeholder="0201256-6"
              />
              {errors.businessId && <p className="text-xs text-danger">{errors.businessId}</p>}
            </div>
            <div className="space-y-1.5">
              <label className={label} htmlFor="sp-phone">Puhelin</label>
              <input
                id="sp-phone"
                className={field}
                value={values.phone}
                onChange={(e) => set("phone", e.target.value)}
                inputMode="tel"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className={label} htmlFor="sp-street">Osoite</label>
            <input
              id="sp-street"
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

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5 col-span-2">
              <label className={label} htmlFor="sp-iban">Tilinumero (IBAN)</label>
              <input
                id="sp-iban"
                className={field}
                value={values.invoiceIban}
                onChange={(e) => set("invoiceIban", e.target.value)}
                onBlur={(e) => set("invoiceIban", formatIban(e.target.value))}
                placeholder="FI21 1234 5600 0007 85"
              />
              {errors.invoiceIban && <p className="text-xs text-danger">{errors.invoiceIban}</p>}
            </div>
            <div className="space-y-1.5">
              <label className={label} htmlFor="sp-bic">BIC</label>
              <input
                id="sp-bic"
                className={field}
                value={values.invoiceBic}
                onChange={(e) => set("invoiceBic", e.target.value.toUpperCase())}
                placeholder="NDEAFIHH"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={label} htmlFor="sp-interest">Viivästyskorko (% / v)</label>
              <input
                id="sp-interest"
                className={field}
                value={values.lateInterestPercent}
                onChange={(e) => set("lateInterestPercent", e.target.value)}
                inputMode="decimal"
                placeholder="11,5"
              />
              {errors.lateInterestPercent ? (
                <p className="text-xs text-danger">{errors.lateInterestPercent}</p>
              ) : (
                <p className="text-xs text-warm-gray">
                  Suomen Pankin viitekorko + 7 (kuluttaja) tai + 8 (yritys) prosenttiyksikköä.
                  Tyhjä = korkoa ei peritä.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className={label} htmlFor="sp-fee">Muistutusmaksu (€)</label>
              <input
                id="sp-fee"
                className={field}
                value={values.reminderFeeCents}
                onChange={(e) => set("reminderFeeCents", e.target.value)}
                inputMode="decimal"
              />
              {errors.reminderFeeCents && (
                <p className="text-xs text-danger">{errors.reminderFeeCents}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className={label} htmlFor="sp-terms">Laskun ehdot</label>
            <textarea
              id="sp-terms"
              className={`${field} min-h-[64px]`}
              value={values.invoiceTerms}
              onChange={(e) => set("invoiceTerms", e.target.value)}
              placeholder="Viivästyskorko 8 %. Huomautusaika 8 päivää."
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-3 rounded-2xl bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Tallennetaan…" : "Tallenna laskuttajan tiedot"}
          </button>

          {message && (
            <p className="text-sm text-warm-gray" role="status">
              {message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
