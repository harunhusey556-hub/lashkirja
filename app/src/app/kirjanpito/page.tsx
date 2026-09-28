"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, Inbox, Landmark, Link2, ListChecks, Lock, Percent, ReceiptEuro } from "lucide-react";
import { Icon, PageTitle, Section, ListRow } from "@/components/ds";
import { apiFetch, readJson } from "@/components/clientFetch";
import { formatDayMonth, formatEur } from "@/lib/format";
import { MONTHS } from "@/lib/finnish-months";
import { nextDueVatPeriod, vatDeadline, type VatPeriod } from "@/lib/vat-deadline";
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
      return () => controller.abort();
    }

    // The next return actually due, not the currently-open period: see
    // nextDueVatPeriod's own doc comment for why (spec §3.1). Any
    // unrecognised value (profile.vatPeriod is a free-form string) falls
    // back to monthly, same as the rest of the app already does.
    const kind = profile.vatPeriod === "quarter" || profile.vatPeriod === "year" ? profile.vatPeriod : "month";
    const period = nextDueVatPeriod(now, kind);
    const key = periodQueryKey(period);

    if (!key) {
      // Yearly: no /api/alv period format for a whole year (see AlvInfo).
      setAlv({ period, amount: null, isRefund: false });
      return () => controller.abort();
    }

    apiFetch(`/api/alv?period=${key}`, { signal: controller.signal })
      .then((response) => readJson<{ field308: { amount: number; isRefund: boolean } }>(response, ""))
      .then((data) => setAlv({ period, amount: data.field308.amount, isRefund: data.field308.isRefund }))
      .catch(() => {});

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

  const alvKey = alv ? periodQueryKey(alv.period) : null;
  const alvHref = alvKey ? `/kirjanpito/alv?period=${alvKey}` : "/kirjanpito/alv";

  return (
    <div className="space-y-6 pb-6">
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

      <Section title="Ilmoitukset ja kaudet">
        <ListRow
          href={alvHref}
          leading={<Icon icon={Percent} />}
          chevron
          title="ALV-ilmoitus"
          amount={alv?.amount != null ? formatEur(alv.amount) : undefined}
          secondary={alv ? alvRowSecondary(alv) : undefined}
        />
        <ListRow
          href="/kirjanpito/ostolaskut"
          leading={<Icon icon={Inbox} />}
          chevron
          title="Ostolaskut"
          amount={purchasesValue}
          amountTone="muted"
        />
        <ListRow
          href="/kirjanpito/pankkitilit"
          leading={<Icon icon={Landmark} />}
          chevron
          title="Pankkitilit"
          amount={bankValue}
          amountTone="muted"
        />
        <ListRow
          href="/kirjanpito/kaudet"
          leading={<Icon icon={Lock} />}
          chevron
          title="Suljetut kaudet"
          amount={lockValue}
          amountTone="muted"
        />
      </Section>
    </div>
  );
}
