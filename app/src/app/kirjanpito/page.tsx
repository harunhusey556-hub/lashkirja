"use client";

import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { ArrowLeftRight, Inbox, Link2, ListChecks, Lock, Percent, ReceiptEuro } from "lucide-react";
import { Icon, PageTitle, Section, ListRow, SlotSkeleton } from "@/components/ds";
import { apiFetch, readJson } from "@/components/clientFetch";
import { MONTHS } from "@/lib/finnish-months";
import { VAT_ROW_TITLE, vatDueAmount, vatDueSecondary } from "@/lib/vat-due";
import { useVatDue } from "@/components/useVatDue";
import { useProfile } from "@/app/asetukset/useProfile";
import { BankConnectSection } from "@/components/BankConnectCard";
import { useCachedResource } from "@/components/useCachedResource";
import { PERIOD_LOCK_KEY, PURCHASE_COUNTS_KEY } from "@/lib/cached-resource";

/**
 * Phase 1 hub, restyled: one place for everything bookkeeping. Phase 3
 * replaces the first section with the single transaction list (spec §3.2) -
 * for now it stays a set of plain links, same as before.
 *
 * The second section's values are read straight from endpoints each detail
 * page already calls (no new API): best-effort, and a failed fetch simply
 * leaves that one row without a value instead of blocking the others.
 */

export default function KirjanpitoPage() {
  const { profile, loadError } = useProfile();

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

  // "Not known yet" (skeleton) vs "known to be empty" (no value): a slot whose
  // refresh failed with nothing cached falls back to no value, like before.
  const pending = (fetch: { value: unknown; failed: boolean }) => fetch.value === null && !fetch.failed;

  const purchasesValue = purchases.value
    ? purchases.value.open + purchases.value.overdue === 1
      ? "1 avoin"
      : `${purchases.value.open + purchases.value.overdue} avointa`
    : undefined;

  const lockedThrough = lock.value?.lockedThrough;
  const lockValue =
    lockedThrough === undefined
      ? undefined
      : lockedThrough === null
        ? "Ei suljettu"
        : `${MONTHS[Number(lockedThrough.slice(5, 7)) - 1]} asti`;

  // ALV row. The profile decides whether the row has a figure at all, so until
  // it is known both the amount and the line under the title are skeletons.
  const alvWaiting = (profile === null && !loadError) || vat.waiting;
  const alvHref = vat.due?.queryKey ? `/kirjanpito/alv?period=${vat.due.queryKey}` : "/kirjanpito/alv";

  return (
    <div className="space-y-6">
      {/* C1.6 (IA-24): pull to refresh runs the same reload as Yritä uudelleen. */}
      <PullToRefresh onRefresh={() => {
          vat.reload();
          purchases.reload();
          lock.reload();
        }} />
      <PageTitle title="Kirjanpito" />

      <Section title="Tapahtumat ja kuitit">
        <ListRow
          href="/kuitit"
          leading={<Icon icon={ReceiptEuro} />}
          chevron
          title="Kuitit"
          secondary="Kaikki kuitit ja niiden tila"
        />
        <ListRow
          href="/pankki/tapahtumat"
          leading={<Icon icon={ArrowLeftRight} />}
          chevron
          title="Tapahtumat"
          secondary="Tiliotteet ja yhdistetyn pankin tapahtumat"
        />
        <ListRow
          href="/pankki/taydennys"
          leading={<Icon icon={Link2} />}
          chevron
          title="Täsmäytys"
          secondary="Kuitit ja tapahtumat ilman linkkiä"
        />
        <ListRow
          href="/tyot"
          leading={<Icon icon={ListChecks} />}
          chevron
          title="Työt ja poikkeukset"
          secondary="Taustatyöt ja avoimet poikkeukset"
        />
      </Section>

      {/* Connect first (OWN-06): one bank row, "Yhdistä" one tap from the tab. */}
      <BankConnectSection />

      <Section title="Ilmoitukset ja kaudet">
        <ListRow
          href={alvHref}
          leading={<Icon icon={Percent} />}
          chevron
          title={VAT_ROW_TITLE}
          amount={alvWaiting ? <SlotSkeleton width={56} /> : (vatDueAmount(vat.figures) ?? undefined)}
          secondary={alvWaiting ? <SlotSkeleton width={176} height={11} tone="soft" /> : vat.due ? vatDueSecondary(vat.due, vat.figures) : undefined}
        />
        <ListRow
          href="/kirjanpito/ostolaskut"
          leading={<Icon icon={Inbox} />}
          chevron
          title="Ostolaskut"
          amount={pending(purchases) ? <SlotSkeleton width={64} /> : purchasesValue}
          amountTone="muted"
        />
        {/* TF-07 / FP-13: the month has a finish line; locking and reopening live behind it. */}
        <ListRow
          href="/kirjanpito/kuukausi"
          leading={<Icon icon={Lock} />}
          chevron
          title="Kuukauden sulkeminen"
          amount={pending(lock) ? <SlotSkeleton width={72} /> : lockValue}
          amountTone="muted"
        />
      </Section>
    </div>
  );
}
