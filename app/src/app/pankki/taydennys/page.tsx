"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { EmptyState } from "@/components/ScreenState";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs } from "@/components/SectionTabs";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatEur } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { activeBankTab, bankTabs } from "@/lib/navigation";
import { bankMatchBadge } from "@/lib/status-badge";

interface UnmatchedTx {
  id: string;
  date: string;
  counterparty: string | null;
  amount: number;
  type: string;
  matchStatus: string;
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
      <PageHeader
        crumbs={[{ href: "/pankki", label: "Pankki" }, { label: "Täsmäytys" }]}
        backHref="/pankki"
        description={
          month
            ? `Avoimet parit kuukaudelta ${month}.`
            : "Avoimet pankkitapahtumat ja kuitit, jotka vielä kaipaavat paria."
        }
      />
      <SectionTabs items={bankTabs()} activeHref={activeBankTab("/pankki/taydennys")} />

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
          body="Tämän kuukauden tapahtumat on käsitelty. Hyvä hetki hengähtää."
        />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-charcoal">Pankkitapahtumat</h2>
            {rows.length === 0 ? (
              <p className="text-sm text-warm-gray">Ei avoimia tapahtumia.</p>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) => (
                  <li key={row.id} className="rounded-2xl bg-white px-4 py-3 shadow-sm">
                    <span className="block text-sm font-medium text-charcoal">
                      {row.counterparty || "Tapahtuma"}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-warm-gray">
                      <span>
                        {row.date.slice(0, 10)} · {formatEur(row.amount)}
                      </span>
                      {(() => {
                        const badge = bankMatchBadge(row.type, row.matchStatus);
                        return badge ? <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge> : null;
                      })()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-charcoal">Kuitit ilman linkkiä</h2>
            {receipts.length === 0 ? (
              <p className="text-sm text-warm-gray">Ei linkittämättömiä kuitteja.</p>
            ) : (
              <ul className="space-y-2">
                {receipts.map((receipt) => (
                  <li key={receipt.id}>
                    <Link
                      href={`/kuitit/${receipt.id}`}
                      className="block rounded-2xl bg-white px-4 py-3 shadow-sm active-press"
                    >
                      <span className="block text-sm font-medium text-charcoal">
                        {receipt.vendor || "Kuitti"}
                      </span>
                      <span className="mt-0.5 block text-xs text-warm-gray">
                        {receipt.date.slice(0, 10)}
                        {receipt.totalAmount != null ? ` · ${formatEur(receipt.totalAmount)}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
