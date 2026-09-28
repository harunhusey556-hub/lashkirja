"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatDate, formatEur } from "@/lib/format";
import { ListRow, PageTitle, Section, StatusTag } from "@/components/ds";
import { EmptyState } from "@/components/ScreenState";
import { MONTHS } from "@/lib/finnish-months";

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
  const [rows, setRows] = useState<UnmatchedTx[] | null>(null);
  const [receipts, setReceipts] = useState<UnlinkedReceipt[] | null>(null);
  const [month, setMonth] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await apiFetch("/api/matching/unmatched");
      const data = await readJson<{
        month?: string;
        unmatchedTx?: UnmatchedTx[];
        unlinkedReceipts?: UnlinkedReceipt[];
      }>(response, "Täsmäytyksen lataus epäonnistui");
      setRows(data.unmatchedTx ?? []);
      setReceipts(data.unlinkedReceipts ?? []);
      setMonth(data.month ?? "");
      setError("");
    } catch (loadError: unknown) {
      if (isUnauthorized(loadError)) {
        redirectToLogin();
        return;
      }
      setError(errorMessage(loadError, "Täsmäytyksen lataus epäonnistui"));
      setRows([]);
      setReceipts([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  const loading = rows === null || receipts === null;

  return (
    <div className="space-y-6 pb-6">
      <PageTitle
        title="Täsmäytys"
        subtitle={`Avoimet pankkitapahtumat ja kuitit${monthAblative(month) ? ` ${monthAblative(month)}` : ""}.`}
      />

      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            setError("");
            setRows(null);
            setReceipts(null);
            void load();
          }}
          compact
        />
      ) : loading ? (
        <LoadingState label="Haetaan täsmäytystä…" />
      ) : rows.length === 0 && receipts.length === 0 ? (
        <EmptyState
          kind="records"
          title="Ei avoimia täsmäytyksiä"
          body="Tämän kuukauden tapahtumat on käsitelty."
        />
      ) : (
        <>
          <Section title="Pankkitapahtumat" count={rows.length}>
            {rows.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-ink-2">Ei avoimia tapahtumia.</p>
            ) : (
              rows.map((row) => (
                <ListRow
                  key={row.id}
                  href={`/pankki/tapahtumat/${row.statementId}`}
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
                  href={`/kuitit/${receipt.id}`}
                  title={receipt.vendor || "Kuitti"}
                  amount={receipt.totalAmount != null ? formatEur(receipt.totalAmount) : undefined}
                  secondary={formatDate(receipt.date)}
                />
              ))
            )}
          </Section>
        </>
      )}
    </div>
  );
}
