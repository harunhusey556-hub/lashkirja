"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { currentMonthKey, formatMonth } from "@/lib/format";

/**
 * Closing the books. Everything dated on or before the chosen month becomes
 * read-only, which is what a filed VAT return needs. Reopening is possible on
 * purpose - corrections happen - but it is a deliberate act.
 */
export default function BooksLockCard() {
  const [lockedThrough, setLockedThrough] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/period-lock", { credentials: "include" });
      const data = await readJson<{ lockedThrough: string | null }>(
        response,
        "Lukituksen haku epäonnistui"
      );
      setLockedThrough(data.lockedThrough);
      setChoice(data.lockedThrough ?? "");
    } catch (error) {
      setMessage(errorMessage(error, "Lukituksen haku epäonnistui"));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional fetch-on-mount: flipping to a loading state and storing the response is exactly the external-system sync this effect exists for
    void load();
  }, [load]);

  async function save(month: string | null) {
    setBusy(true);
    setMessage(null);
    try {
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
      setChoice(data.lockedThrough ?? "");
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
    <div className="bg-white rounded-2xl p-6 shadow-sm space-y-4">
      <div>
        <h3 className="text-lg font-medium text-charcoal">Kirjanpidon lukitus</h3>
        <p className="text-sm text-warm-gray mt-1">
          Valittu kuukausi ja sitä vanhemmat lukitaan: kuitteja, tiliotteita, laskuja tai maksuja
          ei voi enää lisätä, muuttaa eikä poistaa niiltä kausilta.
        </p>
      </div>

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
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
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
          onClick={() => void save(choice || null)}
          disabled={busy}
          className="px-4 py-2.5 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Tallennetaan…" : "Tallenna"}
        </button>
      </div>

      {lockedThrough && (
        <button
          type="button"
          onClick={() => void save(null)}
          disabled={busy}
          className="w-full py-2.5 rounded-xl border border-warm-gray-light/60 text-sm font-medium disabled:opacity-50"
        >
          Avaa kirjanpito uudelleen
        </button>
      )}

      {message && (
        <p className="text-sm text-warm-gray" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
