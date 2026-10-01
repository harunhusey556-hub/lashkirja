"use client";

/** Task 10: shown on /kuitit only while the offline receipt queue is
 * non-empty. Rows come from useOfflineReceiptQueue.ts's shared store, which
 * AppShell.tsx's own mount already drives -- this component only reads and
 * acts on it, it does not need to drive the drain loop itself.
 *
 * BOOKS-19: waiting and sent photos are two different things. "Jonossa"
 * lists what still has to go (with retry and remove on a failure); sent
 * photos collapse to one line with "Poista listalta". The "Ei yhteyttä"
 * notice that brought the user here shows only while something still waits. */
import { useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { Section } from "@/components/ds";
import { receiptTitle } from "@/lib/display-titles";
import { useOfflineReceiptQueue } from "@/components/useOfflineReceiptQueue";
import { tintedButtonClass } from "@/components/control-styles";

function statusText(row: { status: string; lastError?: string }): string {
  if (row.status === "sending") return "Lähetetään…";
  if (row.status === "failed") return row.lastError || "Lähetys epäonnistui.";
  return "Odottaa yhteyttä";
}

export default function QueuedReceiptsCard({ offlineNotice = false }: { offlineNotice?: boolean }) {
  const { rows, retry, remove } = useOfflineReceiptQueue();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearingDone, setClearingDone] = useState(false);

  if (rows.length === 0) return null;

  const waiting = rows.filter((row) => row.status !== "done");
  const sent = rows.filter((row) => row.status === "done");

  async function handleRetry(id: string) {
    setBusyId(id);
    try {
      await retry(id);
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDeleteId) return;
    await remove(confirmDeleteId);
  }

  async function clearSent() {
    setClearingDone(true);
    try {
      for (const row of sent) await remove(row.id);
    } finally {
      setClearingDone(false);
    }
  }

  return (
    <>
      {offlineNotice && waiting.length > 0 && (
        <p className="rounded-card bg-accent-soft px-4 py-3 text-sm text-ink" role="status">
          Ei yhteyttä. Kuva tallennettiin ja lähetetään automaattisesti, kun yhteys palaa.
        </p>
      )}

      {waiting.length > 0 && (
        <Section title="Jonossa">
          {waiting.map((row) => (
            <div key={row.id} className="px-4 py-3">
              <p className="min-w-0 truncate text-body font-medium text-ink">{receiptTitle({ createdAt: new Date(row.createdAt) })}</p>
              <p
                className={`mt-1 text-caption ${row.status === "failed" ? "text-danger" : "text-ink-2"}`}
                role={row.status === "failed" ? "alert" : undefined}
              >
                {statusText(row)}
              </p>
              {row.status === "failed" && (
                <div className="mt-1 flex gap-4">
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => void handleRetry(row.id)}
                    className={tintedButtonClass("accent")}
                  >
                    Yritä uudelleen
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(row.id)}
                    className={tintedButtonClass("danger")}
                  >
                    Poista
                  </button>
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {sent.length > 0 && (
        <Section title="Lähetetyt kuvat">
          <div className="flex items-center gap-3 px-4 py-2">
            <p className="min-w-0 flex-1 text-caption leading-relaxed text-ink-2">
              {sent.length === 1 ? "1 kuva lähetetty." : `${sent.length} kuvaa lähetetty.`} Kuitit näkyvät
              tarkistettavissa, kun ne on luettu.
            </p>
            <button
              type="button"
              onClick={() => void clearSent()}
              disabled={clearingDone}
              className={tintedButtonClass("accent", "shrink-0")}
            >
              Poista listalta
            </button>
          </div>
        </Section>
      )}

      <ConfirmModal
        isOpen={confirmDeleteId !== null}
        title="Poista kuva jonosta?"
        description="Kuvaa ei lähetetä, jos poistat sen jonosta."
        confirmLabel="Poista"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </>
  );
}
