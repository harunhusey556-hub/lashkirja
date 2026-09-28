"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage, readJson } from "@/components/clientFetch";
import { currentMonthKey, formatMonth } from "@/lib/format";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { Button, controlClass } from "@/components/ui";
import { Card, ListRow, Section } from "@/components/ds";
import { normalizeLegacyDetailPath } from "@/lib/routes";

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
    <div className="space-y-6">
      <Card className="space-y-4">
        <div>
          <h3 className="text-[15px] font-medium text-ink">Kirjanpidon lukitus</h3>
          <p className="text-[13px] text-ink-2 mt-1">
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
            <p className="text-[15px] text-ink">
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
                className={`flex-1 ${controlClass}`}
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
              <Button
                type="button"
                onClick={() => {
                  const month = (choice ?? lockedThrough) || null;
                  const acknowledged =
                    Boolean(month) && precheck?.month === month && precheckCount(precheck) > 0;
                  void save(month, acknowledged);
                }}
                busy={busy}
                busyLabel="Tallennetaan…"
              >
                {precheck && precheckCount(precheck) > 0 ? "Lukitse silti" : "Tallenna"}
              </Button>
            </div>

            {lockedThrough && (
              <Button type="button" variant="secondary" className="w-full" busy={busy} onClick={() => void save(null)}>
                Avaa kirjanpito uudelleen
              </Button>
            )}

            {message && (
              <p className="text-[13px] text-ink-2" role="status">
                {message}
              </p>
            )}
          </>
        )}
      </Card>

      {precheck && (
        // role="status": a precheck result appears after a plain button
        // press (no navigation, no dialog) - without a live region a screen
        // reader user never learns it showed up at all.
        <div role="status" className="space-y-6">
          <p className="px-1 text-[15px] font-medium text-ink">
            Ennen lukitusta ({formatMonth(precheck.month)})
          </p>
          <Section title="Puuttuvat tositteet" count={precheck.missingDocuments.length}>
            <PrecheckRows items={precheck.missingDocuments} empty="Ei puuttuvia tositteita." />
          </Section>
          <Section title="Täsmäyttämättömät tapahtumat" count={precheck.unmatchedTransactions.length}>
            <PrecheckRows items={precheck.unmatchedTransactions} empty="Ei avoimia täsmäytyksiä." />
          </Section>
          <Section title="Luonnoslaskut" count={precheck.draftInvoices.length}>
            <PrecheckRows items={precheck.draftInvoices} empty="Ei luonnoslaskuja." />
          </Section>
        </div>
      )}
    </div>
  );
}

function PrecheckRows({ items, empty }: { items: PrecheckItem[]; empty: string }) {
  if (items.length === 0) {
    return <p className="px-4 py-4 text-[15px] text-ink-2">{empty}</p>;
  }
  return (
    <>
      {items.map((item) => (
        <ListRow
          key={item.id}
          href={normalizeLegacyDetailPath(item.href) ?? item.href}
          title={item.title}
          secondary={item.detail}
        />
      ))}
    </>
  );
}
