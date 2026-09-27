"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ErrorState, LoadingState } from "@/components/AsyncState";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatEur } from "@/lib/format";

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
      <p className="text-sm leading-relaxed text-warm-gray">
        Avoimet pankkitapahtumat ja kuitit{month ? ` kuukaudelta ${month}` : ""}.
      </p>

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
        <section className="rounded-3xl border border-warm-gray-light/20 bg-white p-8 text-center shadow-sm">
          <p className="text-base font-medium text-charcoal">Ei avoimia täsmäytyksiä</p>
          <p className="mt-1 text-sm text-warm-gray">Tämän kuukauden tapahtumat on käsitelty.</p>
        </section>
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
                    <span className="mt-0.5 block text-xs text-warm-gray">
                      {row.date.slice(0, 10)} · {formatEur(row.amount)} ·{" "}
                      {row.matchStatus === "suggested" ? "ehdotus" : "avaa"}
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
