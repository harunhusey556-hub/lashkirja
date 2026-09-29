"use client";

import { useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { useCachedResource } from "@/components/useCachedResource";
import { PERIOD_LOCK_KEY } from "@/lib/cached-resource";
import { currentMonthKey, formatMonth } from "@/lib/format";
import { ConnectionNotice } from "@/components/ScreenState";
import { Button, controlClass } from "@/components/ui";
import { Card, ListRow, Section, Skeleton, SkeletonGroup } from "@/components/ds";
import { normalizeLegacyDetailPath } from "@/lib/routes";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";

/**
 * Closing the books. Everything dated on or before the chosen month becomes
 * read-only, which is what a filed VAT return needs. Reopening is possible on
 * purpose - corrections happen - but it is a deliberate act, so both locking
 * and reopening confirm first and name the month (BOOKS-26).
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
  return precheck.missingDocuments.length + precheck.unmatchedTransactions.length + precheck.draftInvoices.length;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("fi") + text.slice(1);
}

/** The last 24 months, newest first; a future month cannot be closed. */
function monthOptions(): string[] {
  const [year, month] = currentMonthKey().split("-").map(Number);
  const options: string[] = [];
  for (let back = 0; back < 24; back += 1) {
    const total = year * 12 + (month - 1) - back;
    const optionYear = Math.floor(total / 12);
    const optionMonth = total - optionYear * 12 + 1;
    options.push(`${optionYear}-${String(optionMonth).padStart(2, "0")}`);
  }
  return options;
}

export default function BooksLockCard() {
  // The lock month paints from the cache on the first frame (shared with the
  // Kirjanpito hub row) and refreshes quietly; the skeleton is only for a
  // first ever visit (N3, L1).
  const lock = useCachedResource<{ lockedThrough: string | null }>(PERIOD_LOCK_KEY, async (signal) => {
    const response = await apiFetch("/api/period-lock", { credentials: "include", signal });
    return readJson<{ lockedThrough: string | null }>(response, "Lukituksen haku epäonnistui");
  });
  const lockedThrough = lock.value?.lockedThrough ?? null;
  // null means "whatever the server says". A pending load must never overwrite
  // a choice the user has already made.
  const [choice, setChoice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const status: "loading" | "ready" | "error" = lock.value ? "ready" : lock.failed ? "error" : "loading";
  const loadError = lock.error;
  const [precheck, setPrecheck] = useState<PeriodPrecheck | null>(null);
  const [actionError, setActionError] = useState("");
  const [confirm, setConfirm] = useState<{ month: string | null } | null>(null);

  const selected = (choice ?? lockedThrough) || null;
  const unchanged = selected === lockedThrough;
  const acknowledged = Boolean(selected) && precheck?.month === selected && precheckCount(precheck) > 0;

  /** Lock: list what is still open first; a clean month goes straight to the confirm. */
  async function requestLock() {
    if (!selected) {
      setConfirm({ month: null });
      return;
    }
    if (acknowledged) {
      setConfirm({ month: selected });
      return;
    }
    setChecking(true);
    setActionError("");
    try {
      const preview = await apiFetch(`/api/period-lock/precheck?month=${selected}`, { credentials: "include" });
      const listed = await readJson<PeriodPrecheck>(preview, "Tarkistus epäonnistui");
      setPrecheck(listed);
      if (precheckCount(listed) === 0) setConfirm({ month: selected });
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setActionError(errorMessage(error, "Tarkistus epäonnistui"));
    } finally {
      setChecking(false);
    }
  }

  async function commit(month: string | null) {
    const response = await apiFetch("/api/period-lock", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    });
    const data = await readJson<{ lockedThrough: string | null }>(response, "Tallennus epäonnistui");
    lock.set({ lockedThrough: data.lockedThrough });
    setChoice(null);
    setPrecheck(null);
    setConfirm(null);
    void hapticNotify("success");
    showToast({
      tone: "success",
      text: data.lockedThrough ? `Kirjanpito lukittu ${formatMonth(data.lockedThrough)} asti.` : "Kirjanpito avattiin.",
    });
  }

  const options = monthOptions();

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        {status === "loading" ? (
          <SkeletonGroup label="Ladataan lukitustietoja" className="space-y-3">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton tone="soft" className="h-3 w-4/5" />
            <Skeleton radius="card" className="h-12 w-full" />
          </SkeletonGroup>
        ) : status === "error" ? (
          <ConnectionNotice
            error={loadError}
            fallback="Lukituksen haku epäonnistui"
            onRetry={lock.reload}
            compact
          />
        ) : (
          <>
            <div>
              <p className="text-[15px] font-medium text-ink">
                {lockedThrough ? `Lukittu ${formatMonth(lockedThrough)} asti` : "Kaikki kaudet ovat auki"}
              </p>
              <p className="mt-0.5 text-[13px] text-ink-2">Valittu kuukausi ja sitä vanhemmat lukitaan.</p>
            </div>

            <div className="flex gap-2">
              <select
                aria-label="Lukitse kaudet tähän kuukauteen asti"
                className={`min-w-0 flex-1 ${controlClass}`}
                value={choice ?? lockedThrough ?? ""}
                onChange={(e) => {
                  setChoice(e.target.value);
                  setPrecheck(null);
                  setActionError("");
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
                onClick={() => void requestLock()}
                busy={checking}
                busyLabel="Tarkistetaan…"
                disabled={unchanged}
                className="shrink-0"
              >
                {!selected ? "Poista lukitus" : acknowledged ? "Lukitse silti" : "Lukitse"}
              </Button>
            </div>

            {lockedThrough && unchanged && (
              <Button type="button" variant="secondary" className="w-full" onClick={() => setConfirm({ month: null })}>
                Avaa kirjanpito uudelleen
              </Button>
            )}

            {actionError && (
              <p className="text-[13px] text-danger" role="alert">
                {actionError}
              </p>
            )}
          </>
        )}
      </Card>

      {precheck && precheckCount(precheck) > 0 && (
        // role="status": a precheck result appears after a plain button
        // press (no navigation, no dialog) - without a live region a screen
        // reader user never learns it showed up at all.
        <div role="status" className="space-y-6">
          <p className="px-1 text-[15px] font-medium text-ink">
            Avoinna ennen lukitusta ({formatMonth(precheck.month)})
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

      <ConfirmModal
        isOpen={confirm !== null}
        title={
          confirm?.month ? `Lukitaanko kaudet ${formatMonth(confirm.month)} asti?` : "Avataanko kirjanpito uudelleen?"
        }
        description={
          confirm?.month
            ? `${capitalize(formatMonth(confirm.month))} ja sitä vanhemmat kaudet muuttuvat vain luettaviksi: kuitteja, tiliotteita, laskuja ja maksuja ei voi lisätä, muuttaa eikä poistaa. Voit avata ne myöhemmin.`
            : "Kaikkia kausia voi taas muuttaa. Tee tämä vain, jos jokin ilmoitettu kausi pitää korjata."
        }
        confirmLabel={confirm?.month ? "Lukitse" : "Avaa kirjanpito"}
        isDestructive={!confirm?.month}
        onConfirm={() => commit(confirm?.month ?? null)}
        onCancel={() => setConfirm(null)}
      />
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
