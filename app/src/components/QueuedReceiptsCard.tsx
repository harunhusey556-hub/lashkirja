"use client";

/** Task 10: shown on /kuitit only while the offline receipt queue is
 * non-empty. Rows come from useOfflineReceiptQueue.ts's shared store, which
 * AppShell.tsx's own mount already drives -- this component only reads and
 * acts on it, it does not need to drive the drain loop itself. */
import { useState } from "react";
import ConfirmModal from "@/components/ConfirmModal";
import { Section } from "@/components/ds";
import { useOfflineReceiptQueue } from "@/components/useOfflineReceiptQueue";

const DONE_NOTE = "Lähetetty. Kuitti löytyy tarkistettavista, kun se on luettu.";

function statusText(row: { status: string; lastError?: string }): string {
  if (row.status === "done") return DONE_NOTE;
  if (row.status === "sending") return "Lähetetään…";
  if (row.status === "failed") return row.lastError || "Lähetys epäonnistui.";
  return "Jonossa";
}

export default function QueuedReceiptsCard() {
  const { rows, retry, remove } = useOfflineReceiptQueue();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (rows.length === 0) return null;

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

  return (
    <>
      <Section title="Odottaa lähetystä">
        {rows.map((row) => (
          <div key={row.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 truncate text-[15px] font-medium text-ink">{row.fileName}</p>
            </div>
            <p
              className={`mt-1 text-[13px] ${row.status === "failed" ? "text-danger" : "text-ink-2"}`}
              role={row.status === "failed" ? "alert" : undefined}
            >
              {statusText(row)}
            </p>
            {row.status === "failed" && (
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  disabled={busyId === row.id}
                  onClick={() => void handleRetry(row.id)}
                  className="min-h-11 text-[13px] font-medium text-accent disabled:opacity-50"
                >
                  Yritä uudelleen
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(row.id)}
                  className="min-h-11 text-[13px] font-medium text-danger"
                >
                  Poista
                </button>
              </div>
            )}
          </div>
        ))}
      </Section>

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
