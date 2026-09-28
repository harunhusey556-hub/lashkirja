"use client";

import { useEffect, useState } from "react";
import { PageTitle, Section, ListRow } from "@/components/ds";
import { apiFetch, readJson } from "@/components/clientFetch";
import { formatDayMonth, formatEur } from "@/lib/format";
import { helsinkiMonthKey } from "@/lib/validation";
import { MONTHS } from "@/lib/finnish-months";

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

/**
 * Kausiveroilmoitus (monthly VAT return) falls due on the 12th day of the
 * second calendar month after the tax period - e.g. a January period is due
 * 12 March.
 */
function alvDueDate(period: string): Date {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + 2, 12));
}

function alvRowSecondary(period: string): string {
  const monthIndex = Number(period.slice(5, 7)) - 1;
  const monthName = MONTHS[monthIndex] ?? period;
  return `${monthName}, eräpäivä ${formatDayMonth(alvDueDate(period).toISOString())}`;
}

export default function KirjanpitoPage() {
  const [alv, setAlv] = useState<{ amount: number; period: string } | null>(null);
  const [openPurchases, setOpenPurchases] = useState<number | null>(null);
  const [bankName, setBankName] = useState<string | null>(null);
  const [hasBankAccounts, setHasBankAccounts] = useState<boolean | null>(null);
  const [lockedThrough, setLockedThrough] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const period = helsinkiMonthKey(new Date());

    apiFetch(`/api/alv?period=${period}`, { signal: controller.signal })
      .then((response) => readJson<{ field308: { amount: number; isRefund: boolean } }>(response, ""))
      .then((data) => setAlv({ amount: data.field308.amount, period }))
      .catch(() => {});

    apiFetch("/api/purchase-invoices?status=open", { credentials: "include", signal: controller.signal })
      .then((response) => readJson<{ invoices: unknown[] }>(response, ""))
      .then((data) => setOpenPurchases(data.invoices.length))
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
          amount={alv ? formatEur(alv.amount) : undefined}
          secondary={alv ? alvRowSecondary(alv.period) : undefined}
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
