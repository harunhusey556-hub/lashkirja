"use client";

import { useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { useCachedResource } from "@/components/useCachedResource";
import { PERIOD_LOCK_KEY } from "@/lib/cached-resource";
import { formatMonth } from "@/lib/format";
import { ConnectionNotice } from "@/components/ScreenState";
import { Button, controlClass } from "@/components/ui";
import { Card, ListRow, Section, Skeleton, SkeletonGroup } from "@/components/ds";
import { normalizeLegacyDetailPath } from "@/lib/routes";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";
import { lockChangeKind, lockMonthOptions, reopenedRangeLabel } from "@/lib/period-lock-copy";

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
  // The dialog keeps what it was opened with while it fades out, so its text
  // cannot flip to a fallback (V47); only `confirmOpen` closes it.
  const [confirm, setConfirm] = useState<{ month: string | null; reopen: boolean; range: string | null } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  function openConfirm(month: string | null, reopen: boolean) {
    // The months a reopen frees, named in the dialog and the toast (F68), fixed at open time.
    const range = reopen && lockedThrough ? reopenedRangeLabel(month, lockedThrough) : null;
    setConfirm({ month, reopen, range });
    setConfirmOpen(true);
  }

  const selected = (choice ?? lockedThrough) || null;
  const change = lockChangeKind(lockedThrough, selected);
  const unchanged = change === "none";
  // An earlier month than the current lock reopens the months after it: never a plain "Lukitse" (F68).
  const reopening = change === "reopen";
  const acknowledged = Boolean(selected) && precheck?.month === selected && precheckCount(precheck) > 0;

  /** Lock: list what is still open first; a clean month goes straight to the confirm. */
  async function requestLock() {
    if (!selected) {
      openConfirm(null, true);
      return;
    }
    if (reopening) {
      openConfirm(selected, true);
      return;
    }
    if (acknowledged) {
      openConfirm(selected, false);
      return;
    }
    setChecking(true);
    setActionError("");
    try {
      const preview = await apiFetch(`/api/period-lock/precheck?month=${selected}`, { credentials: "include" });
      const listed = await readJson<PeriodPrecheck>(preview, "Tarkistus epäonnistui");
      setPrecheck(listed);
      if (precheckCount(listed) === 0) openConfirm(selected, false);
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

  async function commit(month: string | null, reopen: boolean) {
    const previous = lockedThrough;
    // The lock this screen showed: if it has changed elsewhere the server refuses (V48).
    const body = reopen ? { month, reopen, expectedLockedThrough: previous } : { month, expectedLockedThrough: previous };
    let data: { lockedThrough: string | null };
    try {
      const response = await apiFetch("/api/period-lock", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await readJson<{ lockedThrough: string | null }>(response, "Tallennus epäonnistui");
    } catch (error) {
      // Show the real lock behind the dialog, whatever the refusal was.
      lock.reload();
      throw error;
    }
    lock.set({ lockedThrough: data.lockedThrough });
    setChoice(null);
    setPrecheck(null);
    setConfirmOpen(false);
    void hapticNotify("success");
    showToast({
      tone: "success",
      text:
        reopen && previous && data.lockedThrough
          ? `${capitalize(reopenedRangeLabel(data.lockedThrough, previous))} avattiin.`
          : data.lockedThrough
            ? `Kirjanpito lukittu ${formatMonth(data.lockedThrough)} asti.`
            : "Kirjanpito avattiin.",
    });
  }

  const options = lockMonthOptions(new Date(), lockedThrough);
  const reopenRange = confirm?.range ?? null;

  return (
    <div className="space-y-6">
      {status === "error" ? (
        <ConnectionNotice error={loadError} fallback="Lukituksen haku epäonnistui" onRetry={lock.reload} />
      ) : (
      <Card className="space-y-3">
        {status === "loading" ? (
          <SkeletonGroup label="Ladataan lukitustietoja" className="space-y-3">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton tone="soft" className="h-3 w-4/5" />
            <Skeleton radius="card" className="h-12 w-full" />
          </SkeletonGroup>
        ) : (
          <>
            <div>
              <p className="text-body font-medium text-ink">
                {lockedThrough ? `Lukittu ${formatMonth(lockedThrough)} asti` : "Kaikki kaudet ovat auki"}
              </p>
              <p className="mt-0.5 text-caption text-ink-2">Valittu kuukausi ja sitä vanhemmat lukitaan.</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Lukitse kaudet tähän kuukauteen asti"
                className={`min-w-[12rem] flex-1 ${controlClass}`}
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
                className="shrink-0 max-sm:w-full"
              >
                {!selected ? "Poista lukitus" : reopening ? "Avaa kaudet" : acknowledged ? "Lukitse silti" : "Lukitse"}
              </Button>
            </div>

            {lockedThrough && unchanged && (
              <Button type="button" variant="secondary" className="w-full" onClick={() => openConfirm(null, true)}>
                Avaa kirjanpito uudelleen
              </Button>
            )}

            {actionError && (
              <p className="text-caption text-danger" role="alert">
                {actionError}
              </p>
            )}
          </>
        )}
      </Card>
      )}

      {precheck && precheckCount(precheck) > 0 && (
        // role="status": a precheck result appears after a plain button
        // press (no navigation, no dialog) - without a live region a screen
        // reader user never learns it showed up at all.
        <div role="status" className="space-y-6">
          <p className="px-1 text-body font-medium text-ink">
            Avoinna ennen lukitusta ({formatMonth(precheck.month)})
          </p>
          <Section title="Puuttuvat kuitit">
            <PrecheckRows items={precheck.missingDocuments} empty="Ei puuttuvia kuitteja." />
          </Section>
          <Section title="Kohdistamattomat tapahtumat">
            <PrecheckRows items={precheck.unmatchedTransactions} empty="Ei kohdistettavia tapahtumia." />
          </Section>
          <Section title="Luonnoslaskut">
            <PrecheckRows items={precheck.draftInvoices} empty="Ei luonnoslaskuja." />
          </Section>
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        title={
          reopenRange && confirm?.month
            ? `Avataanko ${reopenRange}?`
            : confirm?.month
              ? `Lukitaanko kaudet ${formatMonth(confirm.month)} asti?`
              : "Avataanko kirjanpito uudelleen?"
        }
        description={
          reopenRange && confirm?.month
            ? `Nämä kaudet muuttuvat taas muokattaviksi: ${reopenRange}. Kuitteja, tiliotteita, laskuja ja maksuja voi silloin lisätä, muuttaa ja poistaa. Jos jokin niistä on jo ilmoitettu, avaa ne vain korjausta varten. Kirjanpito pysyy suljettuna ${formatMonth(confirm.month)} asti.`
            : confirm?.month
              ? `${capitalize(formatMonth(confirm.month))} ja sitä vanhemmat kaudet muuttuvat vain luettaviksi: kuitteja, tiliotteita, laskuja ja maksuja ei voi lisätä, muuttaa eikä poistaa. Voit avata ne myöhemmin.`
              : `Nämä kaudet muuttuvat taas muokattaviksi: ${reopenRange ?? "kaikki kaudet"}. Tee tämä vain, jos jokin ilmoitettu kausi pitää korjata.`
        }
        confirmLabel={confirm?.reopen ? "Avaa kaudet" : "Lukitse"}
        isDestructive={Boolean(confirm?.reopen)}
        onConfirm={() => commit(confirm?.month ?? null, Boolean(confirm?.reopen))}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function PrecheckRows({ items, empty }: { items: PrecheckItem[]; empty: string }) {
  if (items.length === 0) {
    return <p className="px-4 py-4 text-body text-ink-2">{empty}</p>;
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
