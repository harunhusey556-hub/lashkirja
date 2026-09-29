"use client";

import { useState } from "react";
import { CircleCheck } from "lucide-react";
import { Card, Icon } from "@/components/ds";
import { Button } from "@/components/ui";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { formatDate, formatDayMonth, formatEur } from "@/lib/format";
import { hapticNotify } from "@/lib/haptics";
import { showToast } from "@/lib/toast";
import { alvSummaryKey, readCached, storeCached } from "@/lib/cached-resource";
import {
  vatChangedSinceFiling,
  vatFilingState,
  vatStateLabel,
  type VatDueFigures,
  type VatFilingRecord,
} from "@/lib/vat-due";

/**
 * "Ilmoita ja maksa" (FP-13, TF-16): how to file the return in OmaVero, and
 * the owner's own record that it was filed and paid. The ALV page is the one
 * home of this; Koti, Kirjanpito and the month close show the state and link
 * here. LashKirja files nothing itself, and the text says so.
 */
export function VatFilingCard({
  periodKey,
  periodLabel,
  dueIso,
  amount,
  isRefund,
  filing,
  periodEnded,
  pendingReceiptCount,
  onChanged,
}: {
  periodKey: string;
  periodLabel: string;
  dueIso: string;
  amount: number;
  isRefund: boolean;
  filing: VatFilingRecord | null;
  periodEnded: boolean;
  pendingReceiptCount: number;
  onChanged: (filing: VatFilingRecord | null) => void;
}) {
  const [busy, setBusy] = useState<null | "filed" | "paid" | "undo">(null);
  const state = vatFilingState(filing);
  const figures: VatDueFigures = { amount, isRefund, filing, pendingReceiptCount };
  const changed = vatChangedSinceFiling(figures);

  async function update(change: { filed?: boolean; paid?: boolean }, which: "filed" | "paid" | "undo") {
    setBusy(which);
    try {
      const response = await apiFetch("/api/alv/filing", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: periodKey, ...change }),
      });
      const result = await readJson<{ filing: VatFilingRecord | null }>(response, "Merkinnän tallennus epäonnistui");
      onChanged(result.filing);
      // Koti and Kirjanpito read the same cache entry (FP-4): update it in place.
      const cached = readCached<VatDueFigures>(alvSummaryKey(periodKey));
      if (cached) storeCached(alvSummaryKey(periodKey), { ...cached, filing: result.filing });
      void hapticNotify("success");
      showToast({
        tone: "success",
        text:
          which === "filed"
            ? "ALV-ilmoitus merkitty annetuksi"
            : which === "paid"
              ? "ALV merkitty maksetuksi"
              : "Merkintä peruttiin",
      });
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Merkinnän tallennus epäonnistui") });
    } finally {
      setBusy(null);
    }
  }

  const due = formatDayMonth(dueIso);
  return (
    <section id="ilmoita" className="scroll-mt-4">
      <h2 className="mb-2 px-1 text-caption font-normal text-ink-2">Ilmoita ja maksa</h2>
      <Card className="space-y-3 text-body text-ink">
        <p className="flex items-center gap-2 font-medium">
          {state !== "open" ? <Icon icon={CircleCheck} className="text-success" /> : null}
          {vatStateLabel(state, isRefund)}
          <span className="font-normal text-ink-2">· eräpäivä {due}</span>
        </p>
        {state === "open" ? (
          <ol className="list-decimal space-y-1 pl-5 text-caption text-ink-2">
            <li>Kirjaudu OmaVeroon (vero.fi/omavero).</li>
            <li>Valitse Arvonlisävero ja kausiveroilmoitus kaudelle {periodLabel}.</li>
            <li>Kirjoita kentät tältä sivulta ja lähetä ilmoitus viimeistään {due}.</li>
            {isRefund ? null : (
              <li>
                Maksa {formatEur(amount)} viimeistään {due}. Viitenumero ja tilinumero ovat OmaVerossa kohdassa
                Maksut.
              </li>
            )}
          </ol>
        ) : null}
        {state === "filed" && !isRefund ? (
          <p className="text-caption text-ink-2">
            Ilmoitettu {filing?.filedAt ? formatDate(filing.filedAt) : ""}. Maksa {formatEur(amount)} viimeistään {due}.
          </p>
        ) : null}
        {state === "paid" ? (
          <p className="text-caption text-ink-2">Maksettu {filing?.paidAt ? formatDate(filing.paidAt) : ""}.</p>
        ) : null}
        {changed ? (
          <p className="text-caption text-warning" role="note">
            Luvut ovat muuttuneet ilmoituksen jälkeen ({formatEur(Math.abs(filing?.filedAmount ?? 0))}). Tarkista, pitääkö
            ilmoitusta korjata OmaVerossa.
          </p>
        ) : null}
        {!periodEnded ? (
          <p className="text-caption text-ink-2">Kausi on vielä kesken. Ilmoita, kun kausi on päättynyt.</p>
        ) : (
          <div className="space-y-2">
            {state === "open" ? (
              <Button className="w-full" busy={busy === "filed"} busyLabel="Tallennetaan…" onClick={() => void update({ filed: true }, "filed")}>
                Merkitse ilmoitetuksi
              </Button>
            ) : null}
            {state === "filed" && !isRefund ? (
              <Button className="w-full" busy={busy === "paid"} busyLabel="Tallennetaan…" onClick={() => void update({ paid: true }, "paid")}>
                Merkitse maksetuksi
              </Button>
            ) : null}
            {state !== "open" ? (
              <Button
                variant="ghost"
                className="w-full"
                busy={busy === "undo"}
                busyLabel="Perutaan…"
                onClick={() => void update(state === "paid" && !isRefund ? { paid: false } : { filed: false }, "undo")}
              >
                {state === "paid" && !isRefund ? "Peru maksettu-merkintä" : "Peru ilmoitettu-merkintä"}
              </Button>
            ) : null}
          </div>
        )}
      </Card>
    </section>
  );
}
