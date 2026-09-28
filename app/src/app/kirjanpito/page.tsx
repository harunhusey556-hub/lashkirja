"use client";

import { useEffect, useState } from "react";
import { PageTitle, Section, ListRow } from "@/components/ds";
import { apiFetch, readJson } from "@/components/clientFetch";
import { formatDayMonth, formatEur } from "@/lib/format";
import { helsinkiMonthKey, helsinkiQuarterKey } from "@/lib/validation";
import { MONTHS } from "@/lib/finnish-months";
import { vatDeadline, type VatPeriod } from "@/lib/vat-deadline";
import { useProfile } from "@/app/asetukset/useProfile";

/**
 * Phase 1 hub, restyled: one place for everything bookkeeping. Phase 3
 * replaces the first section with the single transaction list (spec §3.2) -
 * for now it stays a set of plain links, same as before.
 *
 * The second section's values are read straight from endpoints each detail
 * page already calls (no new API): best-effort, and a failed fetch simply
 * leaves that one row without a value instead of blocking the others.
 */

function PercentIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" d="M6 18 18 6" />
      <circle cx="7.5" cy="7.5" r="1.75" />
      <circle cx="16.5" cy="16.5" r="1.75" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 13h4l1.5 3h5L16 13h4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13 6.2 6.2A2 2 0 0 1 8.16 4.5h7.68a2 2 0 0 1 1.96 1.7L19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Z" />
    </svg>
  );
}

function BankIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 10 12 4l8 6M5 10v9M9.5 10v9M14.5 10v9M19 10v9M3.5 19h17" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path strokeLinecap="round" d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  );
}

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

function alvRowSecondary(info: AlvInfo): string {
  const due = formatDayMonth(vatDeadline(info.period).toISOString());
  const label = periodLabel(info.period);
  if (info.amount === null) return `${label}, eräpäivä ${due}`;
  return `${label}, ${info.isRefund ? "palautettavaa" : "maksettavaa"} ${due}`;
}

export default function KirjanpitoPage() {
  const { profile } = useProfile();
  const [alv, setAlv] = useState<AlvInfo | null>(null);
  const [openPurchases, setOpenPurchases] = useState<number | null>(null);
  const [bankName, setBankName] = useState<string | null>(null);
  const [hasBankAccounts, setHasBankAccounts] = useState<boolean | null>(null);
  const [lockedThrough, setLockedThrough] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!profile) return;
    const controller = new AbortController();
    const now = new Date();

    if (!profile.vatRegistered) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync-to-profile: clearing the ALV row the moment the profile itself says "not registered" is exactly the external-system sync this effect exists for
      setAlv(null);
    } else if (profile.vatPeriod === "quarter") {
      const key = helsinkiQuarterKey(now);
      const [year, quarterPart] = key.split("-Q");
      const period: VatPeriod = { kind: "quarter", year: Number(year), quarter: Number(quarterPart) };
      apiFetch(`/api/alv?period=${key}`, { signal: controller.signal })
        .then((response) => readJson<{ field308: { amount: number; isRefund: boolean } }>(response, ""))
        .then((data) => setAlv({ period, amount: data.field308.amount, isRefund: data.field308.isRefund }))
        .catch(() => {});
    } else if (profile.vatPeriod === "year") {
      setAlv({ period: { kind: "year", year: now.getUTCFullYear() }, amount: null, isRefund: false });
    } else {
      const key = helsinkiMonthKey(now);
      const period: VatPeriod = { kind: "month", year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
      apiFetch(`/api/alv?period=${key}`, { signal: controller.signal })
        .then((response) => readJson<{ field308: { amount: number; isRefund: boolean } }>(response, ""))
        .then((data) => setAlv({ period, amount: data.field308.amount, isRefund: data.field308.isRefund }))
        .catch(() => {});
    }

    return () => controller.abort();
  }, [profile]);

  useEffect(() => {
    const controller = new AbortController();

    // The DB-side counts, not the (capped) invoice list: "open" here means
    // "not yet paid or cancelled", which is `open` (not yet due) plus
    // `overdue` (same raw status, just past its due date) together.
    apiFetch("/api/purchase-invoices/counts", { credentials: "include", signal: controller.signal })
      .then((response) => readJson<{ counts: { open: number; overdue: number } }>(response, ""))
      .then((data) => setOpenPurchases(data.counts.open + data.counts.overdue))
      .catch(() => {});

    apiFetch("/api/bank-accounts", { credentials: "include", signal: controller.signal })
      .then((response) =>
        readJson<{ accounts: Array<{ name: string; bankName: string | null }> }>(response, "")
      )
      .then((data) => {
        setHasBankAccounts(data.accounts.length > 0);
        setBankName(data.accounts[0]?.bankName ?? data.accounts[0]?.name ?? null);
      })
      .catch(() => {});

    apiFetch("/api/period-lock", { credentials: "include", signal: controller.signal })
      .then((response) => readJson<{ lockedThrough: string | null }>(response, ""))
      .then((data) => setLockedThrough(data.lockedThrough))
      .catch(() => {});

    return () => controller.abort();
  }, []);

  const purchasesValue =
    openPurchases === null
      ? undefined
      : openPurchases === 1
        ? "1 avoin"
        : `${openPurchases} avointa`;

  const bankValue =
    hasBankAccounts === null ? undefined : hasBankAccounts ? bankName ?? undefined : "Ei tilejä";

  const lockValue =
    lockedThrough === undefined
      ? undefined
      : lockedThrough === null
        ? "Ei lukittu"
        : `${MONTHS[Number(lockedThrough.slice(5, 7)) - 1]} asti`;

  return (
    <div className="space-y-6 pb-6">
      <PageTitle title="Kirjanpito" />

      <Section title="Tapahtumat ja kuitit">
        <ListRow href="/kuitit" title="Kuitit" secondary="Kaikki kuitit ja niiden tila" />
        <ListRow
          href="/pankki/tapahtumat"
          title="Tapahtumat"
          secondary="Tiliotteet ja yhdistetyn pankin tapahtumat"
        />
        <ListRow href="/pankki/taydennys" title="Täsmäytys" secondary="Kuitit ja tapahtumat ilman linkkiä" />
        <ListRow href="/tyot" title="Työt ja poikkeukset" secondary="Taustatyöt ja avoimet poikkeukset" />
      </Section>

      <Section title="Ilmoitukset ja kaudet">
        <ListRow
          href="/kirjanpito/alv"
          leading={<PercentIcon />}
          title="ALV-ilmoitus"
          amount={alv?.amount != null ? formatEur(alv.amount) : undefined}
          secondary={alv ? alvRowSecondary(alv) : undefined}
        />
        <ListRow
          href="/kirjanpito/ostolaskut"
          leading={<InboxIcon />}
          title="Ostolaskut"
          amount={purchasesValue}
        />
        <ListRow
          href="/kirjanpito/pankkitilit"
          leading={<BankIcon />}
          title="Pankkitilit"
          amount={bankValue}
        />
        <ListRow
          href="/kirjanpito/kaudet"
          leading={<LockIcon />}
          title="Suljetut kaudet"
          amount={lockValue}
        />
      </Section>
    </div>
  );
}
