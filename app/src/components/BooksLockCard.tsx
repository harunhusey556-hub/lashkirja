"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { currentMonthKey, formatMonth } from "@/lib/format";
import Link from "next/link";
import { ErrorState, LoadingState } from "@/components/AsyncState";

/**
 * Closing the books. Everything dated on or before the chosen month becomes
 * read-only, which is what a filed VAT return needs. Reopening is possible on
 * purpose - corrections happen - but it is a deliberate act.
 */
interface PrecheckItem {
  id: string;
  title: string;
  detail: string;
  href: string;
}

interface PeriodPrecheck {
  month: string;
  missingDocuments: PrecheckItem[];
  unmatchedTransactions: PrecheckItem[];
  draftInvoices: PrecheckItem[];
}

function precheckCount(precheck: PeriodPrecheck): number {
  return (
    precheck.missingDocuments.length +
    precheck.unmatchedTransactions.length +
    precheck.draftInvoices.length
  );
}

export default function BooksLockCard() {
  const [lockedThrough, setLockedThrough] = useState<string | null>(null);
  // null means "whatever the server says". A pending load must never overwrite
  // a choice the user has already made.
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [precheck, setPrecheck] = useState<PeriodPrecheck | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/period-lock", { credentials: "include" });
      const data = await readJson<{ lockedThrough: string | null }>(
        response,
        "Lukituksen haku epäonnistui"
      );
      setLockedThrough(data.lockedThrough);
      setStatus("ready");
    } catch (error) {
      setLoadError(errorMessage(error, "Lukituksen haku epäonnistui"));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  async function save(month: string | null, force = false) {
    setBusy(true);
    setMessage(null);
    try {
      if (month && !force) {
        const preview = await apiFetch(`/api/period-lock/precheck?month=${month}`, {
          credentials: "include",
        });
        const listed = await readJson<PeriodPrecheck>(preview, "Tarkistus epäonnistui");
        setPrecheck(listed);
        if (precheckCount(listed) > 0) return;
      }
      const response = await apiFetch("/api/period-lock", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const data = await readJson<{ lockedThrough: string | null }>(
        response,
        "Tallennus epäonnistui"
      );
      setLockedThrough(data.lockedThrough);
      setChoice(null);
      setPrecheck(null);
      setMessage(
        data.lockedThrough
          ? `Kirjanpito lukittu ${formatMonth(data.lockedThrough)} asti.`
          : "Lukitus poistettu."
      );
    } catch (error) {
      setMessage(errorMessage(error, "Tallennus epäonnistui"));
    } finally {
      setBusy(false);
    }
  }

  // Twelve months back from this one; a future month cannot be closed.
  const current = currentMonthKey();
  const options: string[] = [];
  const [year, month] = current.split("-").map(Number);
  for (let back = 0; back < 24; back += 1) {
    const total = year * 12 + (month - 1) - back;
    const optionYear = Math.floor(total / 12);
    const optionMonth = total - optionYear * 12 + 1;
    options.push(`${optionYear}-${String(optionMonth).padStart(2, "0")}`);
  }

  return (
    <div className="bg-white rounded-3xl border border-warm-gray-light/20 shadow-sm p-6 space-y-4">
      <div>
        <h3 className="text-base font-medium text-charcoal">Kirjanpidon lukitus</h3>
        <p className="text-sm text-warm-gray mt-1">
          Valittu kuukausi ja sitä vanhemmat lukitaan: kuitteja, tiliotteita, laskuja tai maksuja
          ei voi enää lisätä, muuttaa eikä poistaa niiltä kausilta.
        </p>
      </div>

      {status === "loading" ? (
        <LoadingState label="Ladataan lukitustietoja…" compact />
      ) : status === "error" ? (
        <ErrorState
          message={loadError || "Lukituksen haku epäonnistui"}
          onRetry={() => {
            setStatus("loading");
            void load();
          }}
          compact
        />
      ) : (
        <>
          <p className="text-sm text-charcoal">
            {lockedThrough ? (
              <>
                Lukittu <span className="font-medium">{formatMonth(lockedThrough)}</span> asti.
              </>
            ) : (
              "Kirjanpito on auki kaikilta kausilta."
            )}
          </p>

          <div className="flex gap-2">
            <select
              aria-label="Lukitse kaudet tähän kuukauteen asti"
              className="flex-1 px-3 py-2.5 rounded-xl border border-warm-gray-light/60 bg-white text-sm"
              value={choice ?? lockedThrough ?? ""}
              onChange={(e) => {
                setChoice(e.target.value);
                setPrecheck(null);
              }}
            >
              <option value="">Ei lukitusta</option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {formatMonth(option)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                const month = (choice ?? lockedThrough) || null;
                const acknowledged =
                  Boolean(month) && precheck?.month === month && precheckCount(precheck) > 0;
                void save(month, acknowledged);
              }}
              disabled={busy}
              className="min-h-11 px-4 py-2.5 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {busy ? "Tallennetaan…" : precheck && precheckCount(precheck) > 0 ? "Lukitse silti" : "Tallenna"}
            </button>
          </div>

          {precheck && (
            <div className="space-y-3 rounded-xl bg-cream/70 px-3 py-3" role="status">
              <p className="text-sm font-medium text-charcoal">
                Ennen lukitusta ({formatMonth(precheck.month)})
              </p>
              <PrecheckList title="Puuttuvat tositteet" items={precheck.missingDocuments} empty="Ei puuttuvia tositteita." />
              <PrecheckList
                title="Täsmäyttämättömät tapahtumat"
                items={precheck.unmatchedTransactions}
                empty="Ei avoimia täsmäytyksiä."
              />
              <PrecheckList title="Luonnoslaskut" items={precheck.draftInvoices} empty="Ei luonnoslaskuja." />
            </div>
          )}

          {lockedThrough && (
            <button
              type="button"
              onClick={() => void save(null)}
              disabled={busy}
              className="w-full min-h-11 py-2.5 rounded-xl border border-warm-gray-light/60 text-sm font-medium disabled:opacity-50"
            >
              Avaa kirjanpito uudelleen
            </button>
          )}

          {message && (
            <p className="text-sm text-warm-gray" role="status">
              {message}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PrecheckList({
  title,
  items,
  empty,
}: {
  title: string;
  items: PrecheckItem[];
  empty: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-warm-gray">
        {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-warm-gray">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id}>
              <Link href={item.href} className="block text-sm text-charcoal leading-relaxed">
                <span className="font-medium">{item.title}</span>
                <span className="text-warm-gray"> · {item.detail}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
