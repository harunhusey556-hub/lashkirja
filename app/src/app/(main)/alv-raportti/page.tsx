"use client";

import { useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import {
  errorMessage,
  isUnauthorized,
  readJson,
  redirectToLogin,
} from "@/components/clientFetch";

interface SalesField {
  label: string;
  netSales: number;
  vat: number;
}

interface ALVData {
  vatRegistered: boolean;
  field301: SalesField;
  field302: SalesField;
  field303: SalesField;
  field309: { label: string; turnover: number };
  field307: { label: string; amount: number };
  field308: { label: string; amount: number; isRefund: boolean };
  review: { salesGross: number; purchasesGross: number; count: number };
  receiptCount: number;
}

function formatEur(n: number): string {
  return n.toLocaleString("fi-FI", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " €";
}

const MONTHS = [
  "Tammikuu",
  "Helmikuu",
  "Maaliskuu",
  "Huhtikuu",
  "Toukokuu",
  "Kesäkuu",
  "Heinäkuu",
  "Elokuu",
  "Syyskuu",
  "Lokakuu",
  "Marraskuu",
  "Joulukuu",
];

export default function ALVRaporttiPage() {
  const now = new Date();
  const defaultPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const [periodType, setPeriodType] = useState<"month" | "quarter">("month");
  const [selectedMonth, setSelectedMonth] = useState(defaultPeriod);
  const [selectedQuarter, setSelectedQuarter] = useState(
    `${now.getFullYear()}-Q${Math.ceil((now.getMonth() + 1) / 3)}`
  );
  const [result, setResult] = useState<{
    period: string;
    data: ALVData;
  } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const period = periodType === "month" ? selectedMonth : selectedQuarter;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/alv?period=${period}`, { signal: controller.signal })
      .then((response) =>
        readJson<ALVData>(response, "ALV-raportin lataus epäonnistui")
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data.field301 || !data.field307 || !data.field308) {
          throw new Error("Palvelin palautti virheellisen ALV-raportin");
        }
        setLoadError("");
        setResult({ period, data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        setLoadError(
          errorMessage(error, "ALV-raportin lataus epäonnistui")
        );
      });
    return () => controller.abort();
  }, [period, loadAttempt]);

  const data = result?.period === period ? result.data : null;
  const loading = !data && !loadError;

  function buildMonthOptions() {
    const opts: { value: string; label: string }[] = [];
    const year = now.getFullYear();
    for (let m = 0; m < 12; m++) {
      const val = `${year}-${String(m + 1).padStart(2, "0")}`;
      opts.push({ value: val, label: `${MONTHS[m]} ${year}` });
    }
    return opts;
  }

  function buildQuarterOptions() {
    const year = now.getFullYear();
    return [1, 2, 3, 4].map((q) => ({
      value: `${year}-Q${q}`,
      label: `Q${q} / ${year}`,
    }));
  }

  return (
    <div className="space-y-6">
        {data && !data.vatRegistered && (
          <div className="bg-warning/10 rounded-2xl p-4 text-sm text-charcoal">
            <p className="font-medium">OmaVero-luonnos</p>
            <p className="mt-1">
              Et ole merkinnyt olevasi ALV-rekisterissä (Asetukset). Tämä
              raportti on vain arvio — ALV-ilmoitusta ei tarvitse antaa, jos
              et ole ALV-rekisterissä.
            </p>
          </div>
        )}

        <div className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setLoadError("");
                setPeriodType("month");
              }}
              aria-pressed={periodType === "month"}
              className={`pressable min-h-12 flex-1 rounded-xl text-sm font-medium ${
                periodType === "month"
                  ? "bg-accent text-white"
                  : "border border-warm-gray-light bg-cream text-charcoal"
              }`}
            >
              Kuukausi
            </button>
            <button
              type="button"
              onClick={() => {
                setLoadError("");
                setPeriodType("quarter");
              }}
              aria-pressed={periodType === "quarter"}
              className={`pressable min-h-12 flex-1 rounded-xl text-sm font-medium ${
                periodType === "quarter"
                  ? "bg-accent text-white"
                  : "border border-warm-gray-light bg-cream text-charcoal"
              }`}
            >
              Neljännes
            </button>
          </div>

          {periodType === "month" ? (
            <select
              aria-label="ALV-raportin kuukausi"
              value={selectedMonth}
              onChange={(e) => {
                setLoadError("");
                setSelectedMonth(e.target.value);
              }}
              className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
            >
              {buildMonthOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <select
              aria-label="ALV-raportin neljännes"
              value={selectedQuarter}
              onChange={(e) => {
                setLoadError("");
                setSelectedQuarter(e.target.value);
              }}
              className="w-full px-3 py-2.5 rounded-xl border border-warm-gray-light bg-cream/50 text-sm"
            >
              {buildQuarterOptions().map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </div>

        {loadError ? (
          <ErrorState
            message={loadError}
            onRetry={() => {
              setLoadError("");
              setLoadAttempt((attempt) => attempt + 1);
            }}
            compact
          />
        ) : loading ? (
          <LoadingState label="Ladataan ALV-raporttia..." compact />
        ) : data ? (
          <div className="space-y-3">
            <p className="text-xs text-warm-gray text-center">
              OmaVero-ilmoituksen kentät · {data.receiptCount} kuittia
              kaudella
            </p>

            {data.review.count > 0 && (
              <div className="bg-warning/10 rounded-2xl p-4 text-sm text-charcoal">
                <p className="font-medium">
                  {data.review.count} kuittia ilman ALV-erittelyä
                </p>
                <p className="mt-1 text-xs text-warm-gray">
                  Myynnit {formatEur(data.review.salesGross)} · Ostot{" "}
                  {formatEur(data.review.purchasesGross)} — lisää
                  ALV-tiedot kuiteille, jotta ne lasketaan mukaan.
                </p>
              </div>
            )}

            <OmaVeroField
              code="301"
              label="Vero kotimaan myynnistä 25,5 %"
              sales={data.field301.netSales}
              vat={data.field301.vat}
            />
            <OmaVeroField
              code="302"
              label="Vero kotimaan myynnistä 13,5 %"
              sales={data.field302.netSales}
              vat={data.field302.vat}
            />
            <OmaVeroField
              code="303"
              label="Vero kotimaan myynnistä 10 %"
              sales={data.field303.netSales}
              vat={data.field303.vat}
            />

            {data.field309.turnover > 0 && (
              <div className="bg-white rounded-2xl p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-mono text-warm-gray">
                      309
                    </span>
                    <p className="text-sm text-charcoal mt-0.5">
                      0-verokannan alainen liikevaihto
                    </p>
                  </div>
                  <p className="text-lg font-medium text-charcoal">
                    {formatEur(data.field309.turnover)}
                  </p>
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl p-5 shadow-sm border-l-4 border-warning">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-warm-gray">
                    307
                  </span>
                  <p className="text-sm text-charcoal mt-0.5">
                    Verokauden vähennettävä vero
                  </p>
                </div>
                <p className="text-lg font-medium text-charcoal">
                  {formatEur(data.field307.amount)}
                </p>
              </div>
            </div>

            <div
              className={`bg-white rounded-2xl p-5 shadow-sm border-l-4 ${
                data.field308.isRefund
                  ? "border-success"
                  : "border-accent"
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-warm-gray">
                    308
                  </span>
                  <p className="text-sm text-charcoal mt-0.5">
                    {data.field308.isRefund
                      ? "Palautukseen oikeuttava vero"
                      : "Maksettava vero"}
                  </p>
                </div>
                <p
                  className={`text-xl font-semibold ${
                    data.field308.isRefund
                      ? "text-success"
                      : "text-accent"
                  }`}
                >
                  {formatEur(data.field308.amount)}
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
  );
}

function OmaVeroField({
  code,
  label,
  sales,
  vat,
}: {
  code: string;
  label: string;
  sales: number;
  vat: number;
}) {
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-xs font-mono text-warm-gray">{code}</span>
          <p className="text-sm text-charcoal mt-0.5">{label}</p>
        </div>
      </div>
      <div className="flex justify-between mt-3 text-sm">
        <span className="text-warm-gray">Myynti (veroton)</span>
        <span className="text-charcoal font-medium">{formatEur(sales)}</span>
      </div>
      <div className="flex justify-between mt-1 text-sm">
        <span className="text-warm-gray">Vero</span>
        <span className="text-charcoal font-medium">{formatEur(vat)}</span>
      </div>
    </div>
  );
}
