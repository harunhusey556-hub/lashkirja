"use client";

import Link from "next/link";
import { apiFetch, readJson } from "@/components/clientFetch";
import { useCachedResource } from "@/components/useCachedResource";
import { UNMATCHED_KEY } from "@/lib/cached-resource";
import { buttonClass } from "@/components/ui";
import { SectionSkeleton } from "@/components/books/Skeletons";
import { SkeletonGroup, useSkeletonFade } from "@/components/ds";
import { formatDate, formatEur } from "@/lib/format";
import { ListRow, PageTitle, Section, StatusTag } from "@/components/ds";
import { ConnectionNotice, EmptyState } from "@/components/ScreenState";
import { MONTHS } from "@/lib/finnish-months";
import { detailHref } from "@/lib/routes";

/** "2026-09" -> "syyskuulta 2026" (every Finnish month name ends in -kuu, ablative -kuulta). */
function monthAblative(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && name ? `${name.toLocaleLowerCase("fi-FI")}lta ${match[1]}` : "";
}

interface UnmatchedTx {
  id: string;
  date: string;
  counterparty: string | null;
  amount: number;
  type: string;
  matchStatus: string;
  statementId: string;
}

interface UnlinkedReceipt {
  id: string;
  vendor: string | null;
  date: string;
  totalAmount: number | null;
  type: string;
}

export default function TaydennysPage() {
  // Painted from the cache and refreshed quietly, so a revisit or a cold launch
  // shows the last list at once; the skeleton is only for a first ever visit (N3, L1).
  const { value, error, reload } = useCachedResource<{
    month: string;
    rows: UnmatchedTx[];
    receipts: UnlinkedReceipt[];
  }>(UNMATCHED_KEY, async (signal) => {
    const response = await apiFetch("/api/matching/unmatched", { signal });
    const data = await readJson<{
      month?: string;
      unmatchedTx?: UnmatchedTx[];
      unlinkedReceipts?: UnlinkedReceipt[];
    }>(response, "Täsmäytyksen lataus epäonnistui");
    return { month: data.month ?? "", rows: data.unmatchedTx ?? [], receipts: data.unlinkedReceipts ?? [] };
  });
  const rows = value?.rows ?? null;
  const receipts = value?.receipts ?? null;
  const month = value?.month ?? "";

  const loading = rows === null || receipts === null;
  const fade = useSkeletonFade(loading && error === null);

  return (
    <div className="space-y-6">
      <PageTitle
        title="Täsmäytys"
        subtitle={`Avoimet pankkitapahtumat ja kuitit${monthAblative(month) ? ` ${monthAblative(month)}` : ""}.`}
      />

      {error != null && loading ? (
        <ConnectionNotice
          error={error}
          fallback="Täsmäytyksen lataus epäonnistui"
          onRetry={reload}
          compact
        />
      ) : loading ? (
        <SkeletonGroup label="Haetaan täsmäytystä" className="space-y-6">
          <SectionSkeleton rows={3} />
          <SectionSkeleton rows={3} />
        </SkeletonGroup>
      ) : rows.length === 0 && receipts.length === 0 ? (
        <EmptyState
          kind="records"
          title="Ei avoimia täsmäytyksiä"
          body="Tämän kuukauden tapahtumat ja kuitit on käsitelty."
          action={
            <Link href="/pankki/tapahtumat" className={buttonClass("secondary")}>
              Avaa tapahtumat
            </Link>
          }
        />
      ) : (
        <div className={`space-y-6 ${fade}`}>
          <Section title="Pankkitapahtumat" count={rows.length}>
            {rows.length === 0 ? (
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  Ei avoimia pankkitapahtumia. Ne tulevat tähän tiliotteelta tai yhdistetystä pankista.
                </p>
                <Link href="/pankki/tapahtumat" className="active-press inline-flex min-h-11 shrink-0 items-center text-[13px] font-medium text-accent">
                  Tapahtumat
                </Link>
              </div>
            ) : (
              rows.map((row) => (
                <ListRow
                  key={row.id}
                  href={detailHref("statement", row.statementId)}
                  title={row.counterparty || "Tapahtuma"}
                  amount={formatEur(row.amount)}
                  secondary={formatDate(row.date)}
                  ariaLabel={`${row.counterparty || "Tapahtuma"}, ${formatEur(row.amount)}, ${formatDate(row.date)}`}
                  trailing={
                    row.matchStatus === "suggested" ? (
                      <StatusTag tone="warning">Ehdotus</StatusTag>
                    ) : undefined
                  }
                />
              ))
            )}
          </Section>

          <Section title="Kuitit ilman linkkiä" count={receipts.length}>
            {receipts.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-ink-2">Ei linkittämättömiä kuitteja.</p>
            ) : (
              receipts.map((receipt) => (
                <ListRow
                  key={receipt.id}
                  href={detailHref("receipt", receipt.id)}
                  title={receipt.vendor || "Kuitti"}
                  amount={receipt.totalAmount != null ? formatEur(receipt.totalAmount) : undefined}
                  secondary={formatDate(receipt.date)}
                />
              ))
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
