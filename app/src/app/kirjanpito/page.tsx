"use client";

import { ProgressRing } from "@/components/ds/ProgressRing";
import { helsinkiMonthKey } from "@/lib/validation";
import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { BookOpen, Inbox, ListChecks, LockKeyhole, Percent, ReceiptEuro } from "lucide-react";
import { Icon, PageTitle, Section, ListRow, SlotSkeleton } from "@/components/ds";
import { apiFetch, readJson } from "@/components/clientFetch";
import { MONTHS } from "@/lib/finnish-months";
import { VAT_ROW_TITLE, vatDueAmount, vatDueSecondary } from "@/lib/vat-due";
import { useVatDue } from "@/components/useVatDue";
import { useProfile } from "@/app/asetukset/useProfile";
import { BankConnectRowView } from "@/components/BankConnectCard";
import { useBankConnections } from "@/components/bank/useBankConnections";
import { pageCacheFetchedAt } from "@/lib/page-cache";
import { ConnectionNotice, StaleBanner } from "@/components/ScreenState";
import { firstHubFailure } from "@/lib/hub-failure";
import { useCachedResource } from "@/components/useCachedResource";
import { PERIOD_LOCK_KEY, PURCHASE_COUNTS_KEY } from "@/lib/cached-resource";

/**
 * Bookkeeping hub: one place for everything bookkeeping. Phase 3
 * replaces the first section with the single transaction list (spec §3.2) -
 * for now it stays a set of plain links, same as before.
 *
 * The second section's values are read straight from endpoints each detail
 * page already calls (no new API): best-effort, and a failed fetch simply
 * leaves that one row without a value instead of blocking the others.
 */

export default function KirjanpitoPage() {
  const { profile, loadError, retry: retryProfile } = useProfile();

  // FP-4 / TF-01: the next return actually due (nextDueVatPeriod), with the
  // same figures, words and state as Koti, from the same cache entry. A yearly
  // filer has no /api/alv period, so that row shows the due date only.
  const vat = useVatDue(profile);

  // Every value below paints from the page cache on the first frame and
  // refreshes quietly (N3); a slot with nothing cached yet shows a skeleton,
  // never a zero. A failed refresh keeps the cached value.
  // The DB-side counts, not the (capped) invoice list: "open" here means
  // "not yet paid or cancelled", which is `open` (not yet due) plus
  // `overdue` (same raw status, just past its due date) together.
  const purchases = useCachedResource<{ open: number; overdue: number; paid: number; cancelled: number }>(
    PURCHASE_COUNTS_KEY,
    async (signal) => {
      const response = await apiFetch("/api/purchase-invoices/counts", { credentials: "include", signal });
      return (await readJson<{ counts: { open: number; overdue: number; paid: number; cancelled: number } }>(response, "")).counts;
    }
  );
  const lock = useCachedResource<{ lockedThrough: string | null }>(PERIOD_LOCK_KEY, async (signal) => {
    const response = await apiFetch("/api/period-lock", { credentials: "include", signal });
    return readJson<{ lockedThrough: string | null }>(response, "");
  });
  const bank = useBankConnections();
  const month = helsinkiMonthKey();
  const overview = useCachedResource<{
    events?: { done: number; total: number };
    matching: { matched: number; matchable: number };
    sectionErrors?: Record<string, string>;
  }>(`dashboard:${month}`, async (signal) => {
    const response = await apiFetch(`/api/dashboard?month=${month}`, { credentials: "include", signal });
    return readJson(response, "Kirjanpidon tilaa ei saatu haettua");
  });
  const events = overview.value?.events ?? (overview.value ? {
    done: overview.value.matching.matched, total: overview.value.matching.matchable,
  } : null);
  const statusError = overview.value?.sectionErrors?.matching;
  const openEvents = events && !statusError ? Math.max(0, events.total - events.done) : 0;

  // One failure card with one retry when a value failed and nothing is cached
  // in its place (F34). The link rows stay: they are navigation and still work.
  const failure = firstHubFailure([
    { failed: overview.failed || Boolean(statusError), empty: overview.value === null || Boolean(statusError), error: overview.error || statusError },
    { failed: purchases.failed, empty: purchases.value === null, error: purchases.error },
    { failed: lock.failed, empty: lock.value === null, error: lock.error },
    { failed: bank.error !== null, empty: bank.data === null, error: bank.error },
    { failed: vat.failed, empty: vat.figures === null },
    { failed: Boolean(loadError), empty: profile === null },
  ]);
  const stale = !failure && (overview.failed || purchases.failed || lock.failed || Boolean(bank.error) || vat.failed || Boolean(loadError));
  const reloadAll = () => {
    overview.reload();
    vat.reload();
    purchases.reload();
    lock.reload();
    bank.reload();
    retryProfile();
  };

  // "Not known yet" (skeleton) vs "known to be empty" (no value): a slot whose
  // refresh failed with nothing cached falls back to no value, like before.
  const pending = (fetch: { value: unknown; failed: boolean }) => fetch.value === null && !fetch.failed;

  const purchasesValue = purchases.value
    ? purchases.value.open + purchases.value.overdue === 1
      ? "1 avoinna"
      : `${purchases.value.open + purchases.value.overdue} avoinna`
    : undefined;

  const lockedThrough = lock.value?.lockedThrough;
  const lockValue =
    lockedThrough === undefined
      ? undefined
      : lockedThrough === null
        ? "Ei lukittu"
        : `${MONTHS[Number(lockedThrough.slice(5, 7)) - 1]} asti`;

  // ALV row. The profile decides whether the row has a figure at all, so until
  // it is known both the amount and the line under the title are skeletons.
  const alvWaiting = (profile === null && !loadError) || vat.waiting;
  const alvHref = vat.due?.queryKey ? `/kirjanpito/alv?period=${vat.due.queryKey}` : "/kirjanpito/alv";

  return (
    <div className="stitch-page space-y-6">
      {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
      <PullToRefresh onRefresh={reloadAll} />
      <PageTitle title="Kirjanpito" />

      {failure && (
        <ConnectionNotice error={failure.error} fallback="Kirjanpidon tietoja ei saatu haettua" onRetry={reloadAll} />
      )}

      {stale ? <StaleBanner fetchedAt={overview.failed ? pageCacheFetchedAt(`dashboard:${month}`) : null} onRetry={reloadAll} /> : null}

      <div className="stitch-card stitch-status">
        {events && !statusError ? (
          <>
            <ProgressRing done={events.done} total={events.total} />
            <p className="text-body font-medium text-ink">{events.total > 0 ? `${events.done} / ${events.total} tapahtumaa kunnossa` : "Ei tapahtumia tässä kuussa"}</p>
          </>
        ) : overview.failed || statusError ? (
          <p className="text-body text-ink-2">Tilaa ei saatu haettua</p>
        ) : <SlotSkeleton width={220} height={48} />}
      </div>

      <Section title="Tapahtumat ja kuitit">
        <div data-tone="green"><ListRow href="/kuitit" leading={<Icon icon={ReceiptEuro} />} chevron title="Kuitit" secondary="Kaikki kuitit ja niiden tila" /></div>
        {/* One row for the bank's transactions. A separate "Täsmäytys" row opened
            the same list with its "Vaatii toimia" chip on, which looked identical
            until there were rows; the open count now leads straight to that view. */}
        <ListRow
          href={openEvents > 0 ? "/pankki/tapahtumat?nayta=toimet" : "/pankki/tapahtumat"}
          leading={<Icon icon={ListChecks} />}
          chevron
          title="Tapahtumat"
          secondary={openEvents > 0 ? `${openEvents} odottaa kohdistusta tässä kuussa` : "Tiliotteet ja pankin tapahtumat"}
        />
      </Section>

      <Section title="Pankki">
        {/* One row for the bank: it used to sit beside a "Pankkitilit" row, and
            both opened a screen led by the same "connect your bank" card. */}
        <BankConnectRowView data={bank.data} error={bank.error} quietError />
      </Section>

      <Section title="Ilmoitukset ja kaudet">
        <ListRow
          href={alvHref}
          leading={<Icon icon={Percent} />}
          chevron
          title={VAT_ROW_TITLE}
          amount={alvWaiting ? <SlotSkeleton width={56} /> : (vatDueAmount(vat.figures) ?? undefined)}
          secondary={alvWaiting ? <SlotSkeleton width={176} height={11} tone="soft" /> : vat.due ? vatDueSecondary(vat.due, vat.figures) : undefined}
        />
        <ListRow href="/kirjanpito/ostolaskut" leading={<Icon icon={Inbox} />} chevron title="Ostolaskut" amount={pending(purchases) ? <SlotSkeleton width={64} /> : purchasesValue} amountTone="muted" />
        {/* F67: locked months and reopening have their own row, so the lock error can point here. */}
        <ListRow
          href="/kirjanpito/kaudet"
          leading={<Icon icon={LockKeyhole} />}
          chevron
          title="Suljetut kaudet"
          amount={pending(lock) ? <SlotSkeleton width={72} /> : lockValue}
          amountTone="muted"
        />
        <ListRow
          href="/kirjanpito/paakirja"
          leading={<Icon icon={BookOpen} />}
          chevron
          title="Kirjanpito"
          secondary="Tuloslaskelma, tase, saldoluettelo ja päiväkirja"
        />
      </Section>
    </div>
  );
}
