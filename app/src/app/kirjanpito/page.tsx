"use client";

import { useMemo } from "react";
import { ArrowLeftRight, Inbox, Link2, ListChecks, Lock, Percent, ReceiptEuro, Wallet } from "lucide-react";
import { Icon, PageTitle, Section, ListRow, SlotSkeleton } from "@/components/ds";
import { apiFetch, readJson } from "@/components/clientFetch";
import { formatDayMonth, formatEur } from "@/lib/format";
import { MONTHS } from "@/lib/finnish-months";
import { nextDueVatPeriod, vatDeadline, type VatPeriod } from "@/lib/vat-deadline";
import { useProfile } from "@/app/asetukset/useProfile";
import { BankConnectRow } from "@/components/BankConnectCard";
import { useCachedResource } from "@/components/useCachedResource";
import { BANK_ACCOUNT_COUNT_KEY, PERIOD_LOCK_KEY, PURCHASE_COUNTS_KEY, alvSummaryKey } from "@/lib/cached-resource";

/**
 * Phase 1 hub, restyled: one place for everything bookkeeping. Phase 3
 * replaces the first section with the single transaction list (spec §3.2) -
 * for now it stays a set of plain links, same as before.
 *
 * The second section's values are read straight from endpoints each detail
 * page already calls (no new API): best-effort, and a failed fetch simply
 * leaves that one row without a value instead of blocking the others.
 */

interface AlvInfo {
  period: VatPeriod;
  /** null for a yearly filer: /api/alv has no "whole year" period to query
   * cheaply (its period schema only accepts "YYYY-MM" or "YYYY-Qn"), and
   * showing a single month's figure mislabelled as the year's total would be
   * actively misleading in a bookkeeping app - so the row shows the due date
   * only, with neither an amount nor a maksettavaa/palautettavaa word. */
  amount: number | null;
  isRefund: boolean;
}

/** "Syyskuu 2026" / "Q3/2026" / "2026", matching the label the ALV page itself uses for each kind. */
function periodLabel(period: VatPeriod): string {
  if (period.kind === "month") return `${MONTHS[period.month! - 1]} ${period.year}`;
  if (period.kind === "quarter") return `Q${period.quarter}/${period.year}`;
  return String(period.year);
}

/** The `?period=` value the ALV page's own query parser understands
 * (`YYYY-MM` or `YYYY-Qn`); a yearly period has no such format there. */
function periodQueryKey(period: VatPeriod): string | null {
  if (period.kind === "month") return `${period.year}-${String(period.month).padStart(2, "0")}`;
  if (period.kind === "quarter") return `${period.year}-Q${period.quarter}`;
  return null;
}

function alvRowSecondary(info: AlvInfo): string {
  const due = formatDayMonth(vatDeadline(info.period).toISOString());
  const label = periodLabel(info.period);
  // The amount sits in the row's amount slot; the date is always named as the due date (BOOKS-05).
  if (info.amount !== null && info.isRefund) return `${label}, palautus, eräpäivä ${due}`;
  return `${label}, eräpäivä ${due}`;
}

export default function KirjanpitoPage() {
  const { profile, loadError } = useProfile();

  // The next return actually due, not the currently-open period: see
  // nextDueVatPeriod's own doc comment for why (spec §3.1). Any unrecognised
  // value (profile.vatPeriod is a free-form string) falls back to monthly,
  // same as the rest of the app already does. Worked out from the profile
  // alone, so the row's label and due date never wait for the network.
  const alvPeriod = useMemo<VatPeriod | null>(() => {
    if (!profile?.vatRegistered) return null;
    const kind = profile.vatPeriod === "quarter" || profile.vatPeriod === "year" ? profile.vatPeriod : "month";
    return nextDueVatPeriod(new Date(), kind);
  }, [profile?.vatRegistered, profile?.vatPeriod]);
  // Yearly: no /api/alv period format for a whole year (see AlvInfo), so nothing to fetch.
  const alvQuery = alvPeriod ? periodQueryKey(alvPeriod) : null;

  // Every value below paints from the page cache on the first frame and
  // refreshes quietly (N3); a slot with nothing cached yet shows a skeleton,
  // never a zero. A failed refresh keeps the cached value.
  const alvFetch = useCachedResource<{ amount: number; isRefund: boolean }>(
    alvQuery ? alvSummaryKey(alvQuery) : null,
    async (signal) => {
      const response = await apiFetch(`/api/alv?period=${alvQuery}`, { signal });
      const data = await readJson<{ field308: { amount: number; isRefund: boolean } }>(response, "");
      return { amount: data.field308.amount, isRefund: data.field308.isRefund };
    }
  );
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
  const accounts = useCachedResource<{ count: number }>(BANK_ACCOUNT_COUNT_KEY, async (signal) => {
    const response = await apiFetch("/api/bank-accounts", { credentials: "include", signal });
    const data = await readJson<{ accounts: Array<{ id: string }> }>(response, "");
    return { count: data.accounts.length };
  });
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

  // A count, never "Ei tilejä": an archived account still exists, and the
  // connect row above already carries the call to action (BOOKS-05).
  const bankValue =
    !accounts.value || accounts.value.count === 0
      ? undefined
      : accounts.value.count === 1
        ? "1 tili"
        : `${accounts.value.count} tiliä`;

  const lockedThrough = lock.value?.lockedThrough;
  const lockValue =
    lockedThrough === undefined
      ? undefined
      : lockedThrough === null
        ? "Ei lukittu"
        : `${MONTHS[Number(lockedThrough.slice(5, 7)) - 1]} asti`;

  // ALV row. The profile decides whether the row has a figure at all, so until
  // it is known both the amount and the line under the title are skeletons.
  const alvWaiting = (profile === null && !loadError) || (alvQuery !== null && pending(alvFetch));
  const alv: AlvInfo | null =
    alvPeriod && !alvWaiting
      ? { period: alvPeriod, amount: alvFetch.value?.amount ?? null, isRefund: alvFetch.value?.isRefund ?? false }
      : null;

  const alvKey = alvQuery;
  const alvHref = alvKey ? `/kirjanpito/alv?period=${alvKey}` : "/kirjanpito/alv";

  return (
    <div className="space-y-6">
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

      {/* Connect first (OWN-06): "Yhdistä pankki" one tap from the tab. */}
      <Section title="Pankki">
        <BankConnectRow />
        <ListRow
          href="/kirjanpito/pankkitilit"
          leading={<Icon icon={Wallet} />}
          chevron
          title="Pankkitilit"
          secondary="Tilit ja kuukausien saldot"
          amount={pending(accounts) ? <SlotSkeleton width={44} /> : bankValue}
          amountTone="muted"
        />
      </Section>

      <Section title="Ilmoitukset ja kaudet">
        <ListRow
          href={alvHref}
          leading={<Icon icon={Percent} />}
          chevron
          title="ALV-ilmoitus"
          amount={alvWaiting ? <SlotSkeleton width={56} /> : alv?.amount != null ? formatEur(alv.amount) : undefined}
          secondary={alvWaiting ? <SlotSkeleton width={176} height={11} tone="soft" /> : alv ? alvRowSecondary(alv) : undefined}
        />
        <ListRow
          href="/kirjanpito/ostolaskut"
          leading={<Icon icon={Inbox} />}
          chevron
          title="Ostolaskut"
          amount={pending(purchases) ? <SlotSkeleton width={64} /> : purchasesValue}
          amountTone="muted"
        />
        <ListRow
          href="/kirjanpito/kaudet"
          leading={<Icon icon={Lock} />}
          chevron
          title="Suljetut kaudet"
          amount={pending(lock) ? <SlotSkeleton width={72} /> : lockValue}
          amountTone="muted"
        />
      </Section>
    </div>
  );
}
