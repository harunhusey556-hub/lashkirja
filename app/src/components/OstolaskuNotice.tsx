"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { tintedButtonClass } from "@/components/control-styles";
import { formatDate } from "@/lib/format";
import { showToast } from "@/lib/toast";

/** GET /api/receipts/[id]/purchase-invoice (lib/purchase-invoices.ts ReceiptPurchaseInvoiceView). */
export interface OstolaskuView {
  documentType: string | null;
  purchaseInvoice: {
    id: string;
    status: "open" | "paid" | "cancelled";
    displayStatus: "open" | "paid" | "cancelled" | "overdue";
    dueDate: string;
    dueDateAssumed: boolean;
  } | null;
}

/** Why no ostolasku could be filed, in the owner's words (ReceiptFilingSkip). */
const SKIP_TEXT: Record<string, string> = {
  sales_document: "Myyntitositteesta ei tehdä ostolaskua.",
  no_supplier: "Lisää myyjä ja tallenna, niin ostolasku voidaan luoda.",
  no_date: "Lisää päivämäärä ja tallenna, niin ostolasku voidaan luoda.",
  no_amount: "Lisää summa ja tallenna, niin ostolasku voidaan luoda.",
  duplicate: "Sama lasku on jo ostolaskuissa.",
  already_filed: "Ostolasku on peruttu Ostolaskut-näkymässä. Avaa se sieltä.",
};

/**
 * One document, one home: a receipt filed as an ostolasku says so and links
 * there, with its due date ("oletus" when the bill printed none). The owner
 * can also say what the document is - "Ei ole lasku" cancels the ostolasku
 * (kept, with its history), "Merkitse ostolaskuksi" files or reopens it.
 */
export function OstolaskuNoticeView({
  view,
  busy,
  onSetKind,
}: {
  view: OstolaskuView;
  busy: boolean;
  onSetKind: (kind: "invoice" | "receipt") => void;
}) {
  const invoice = view.purchaseInvoice;
  if (invoice && invoice.status !== "cancelled") {
    return (
      <div role="note" className="rounded-card bg-accent-soft px-4 py-3 text-caption text-ink">
        <p>
          <span className="font-semibold">Tämä on ostolasku</span>
          {" · "}Eräpäivä {formatDate(invoice.dueDate)}
          {invoice.dueDateAssumed ? " (oletus)" : ""}
          {invoice.status === "paid" ? " · Maksettu" : invoice.displayStatus === "overdue" ? " · Myöhässä" : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href={`/kirjanpito/ostolaskut?id=${encodeURIComponent(invoice.id)}`} className={tintedButtonClass("accent")}>
            Avaa ostolasku
          </Link>
          {invoice.status === "open" ? (
            <button type="button" disabled={busy} onClick={() => onSetKind("receipt")} className={tintedButtonClass("neutral")}>
              Ei ole lasku
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-2">
      {invoice ? "Ostolasku on peruttu, tämä on kuitti." : "Onko tämä lasku, joka maksetaan myöhemmin?"}
      <button type="button" disabled={busy} onClick={() => onSetKind("invoice")} className={tintedButtonClass("accent")}>
        Merkitse ostolaskuksi
      </button>
    </p>
  );
}

export default function OstolaskuNotice({ receiptId, receiptType }: { receiptId: string; receiptType: string }) {
  const [view, setView] = useState<OstolaskuView | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch(`/api/receipts/${encodeURIComponent(receiptId)}/purchase-invoice`, { signal: controller.signal })
      .then((response) => readJson<OstolaskuView>(response, "Ostolaskun tietoja ei saatu haettua"))
      .then((data) => {
        if (!controller.signal.aborted) setView(data);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (isUnauthorized(error)) {
          redirectToLogin();
          return;
        }
        // The notice is extra information on the receipt screen; without it the editor still works.
        console.warn("Ostolasku notice could not load:", error);
      });
    return () => controller.abort();
  }, [receiptId, attempt]);

  async function setKind(kind: "invoice" | "receipt") {
    setBusy(true);
    try {
      const response = await apiFetch(`/api/receipts/${encodeURIComponent(receiptId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentType: kind }),
      });
      const result = await readJson<{ purchaseInvoiceAction: string; purchaseInvoiceSkipped: string | null }>(
        response,
        "Muutos epäonnistui"
      );
      if (result.purchaseInvoiceAction === "none" && result.purchaseInvoiceSkipped && SKIP_TEXT[result.purchaseInvoiceSkipped]) {
        showToast({ tone: "info", text: SKIP_TEXT[result.purchaseInvoiceSkipped] });
      } else {
        showToast({
          tone: "success",
          text: kind === "invoice" ? "Tallennettu ostolaskuksi" : "Merkitty kuitiksi, ostolasku peruttiin",
        });
      }
      setAttempt((value) => value + 1);
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Muutos epäonnistui") });
    } finally {
      setBusy(false);
    }
  }

  // A sales document is never an ostolasku; nothing to say until the view is known.
  if (!view || (receiptType === "tulo" && !view.purchaseInvoice)) return null;
  return <OstolaskuNoticeView view={view} busy={busy} onSetKind={(kind) => void setKind(kind)} />;
}
