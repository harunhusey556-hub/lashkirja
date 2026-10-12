"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { PageTitle } from "@/components/ds";
import { PullToRefresh } from "@/components/ds/PullToRefresh";
import { SkeletonList } from "@/components/AsyncState";
import { ConnectionNotice, EmptyState } from "@/components/ScreenState";
import { Button } from "@/components/ui";
import { apiFetch, errorMessage, isUnauthorized, readJson, redirectToLogin } from "@/components/clientFetch";
import { showToast } from "@/lib/toast";
import { hapticNotify } from "@/lib/haptics";
import {
  PurchaseMatchList,
  isSureSuggestion,
  purchaseMatchRows,
  type OpenPurchase,
  type PaymentSuggestion,
} from "./PurchaseMatchList";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Kohdista ostolaskujen maksut: every open ostolasku with the outgoing bank
 * payment the matcher proposes for it (GET /api/purchase-invoices/match), to
 * accept or reject one by one, or all the sure ones at once. Accepting is the
 * same payment the ostolasku sheet records; rejecting means the pair is not
 * proposed again.
 */
export default function PurchaseMatchPage() {
  const [invoices, setInvoices] = useState<OpenPurchase[]>([]);
  const [suggestions, setSuggestions] = useState<PaymentSuggestion[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadFailure, setLoadFailure] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [listResponse, matchResponse] = await Promise.all([
        apiFetch("/api/purchase-invoices?status=open", { credentials: "include", signal }),
        apiFetch("/api/purchase-invoices/match", { credentials: "include", signal }),
      ]);
      const list = await readJson<{ invoices: OpenPurchase[] }>(listResponse, "Ostolaskujen haku epäonnistui");
      const match = await readJson<{ suggestions: PaymentSuggestion[] }>(matchResponse, "Maksuehdotusten haku epäonnistui");
      if (signal?.aborted) return;
      setInvoices(list.invoices);
      setSuggestions(match.suggestions);
      setLoadFailure(null);
      setStatus("ready");
    } catch (error) {
      if (signal?.aborted) return;
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      setLoadFailure(error);
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: storing the response is the external-system sync this effect exists for
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function recordPayment(suggestion: PaymentSuggestion) {
    const response = await apiFetch(`/api/purchase-invoices/${suggestion.invoiceId}/payments`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: suggestion.amount,
        paidDate: suggestion.paidDate ?? today(),
        transactionId: suggestion.transactionId,
      }),
    });
    await readJson(response, "Maksun kirjaus epäonnistui");
  }

  async function accept(suggestion: PaymentSuggestion) {
    setBusyId(suggestion.invoiceId);
    try {
      await recordPayment(suggestion);
      void hapticNotify("success");
      showToast({ tone: "success", text: "Maksu kohdistettiin" });
      await load();
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Maksun kirjaus epäonnistui") });
    } finally {
      setBusyId(null);
    }
  }

  async function reject(suggestion: PaymentSuggestion) {
    setBusyId(suggestion.invoiceId);
    try {
      const response = await apiFetch("/api/purchase-invoices/match/reject", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: suggestion.invoiceId, transactionId: suggestion.transactionId }),
      });
      await readJson(response, "Hylkäys epäonnistui");
      showToast({ tone: "success", text: "Ehdotus hylättiin" });
      await load();
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      showToast({ tone: "error", text: errorMessage(error, "Hylkäys epäonnistui") });
    } finally {
      setBusyId(null);
    }
  }

  /** Viite hits first (the server books those itself), then every sure proposal left. */
  async function acceptAllSure() {
    setBulkBusy(true);
    let accepted = 0;
    let failed = 0;
    try {
      const response = await apiFetch("/api/purchase-invoices/match", { method: "POST", credentials: "include" });
      const result = await readJson<{ applied: unknown[]; suggestions: PaymentSuggestion[] }>(
        response,
        "Kohdistus epäonnistui"
      );
      accepted += result.applied.length;
      // One at a time: each payment changes what is still open on its invoice.
      for (const suggestion of result.suggestions.filter(isSureSuggestion)) {
        try {
          await recordPayment(suggestion);
          accepted += 1;
        } catch (error) {
          if (isUnauthorized(error)) throw error;
          failed += 1;
        }
      }
      void hapticNotify(failed > 0 ? "warning" : "success");
      showToast({
        tone: failed > 0 ? "error" : "success",
        text:
          accepted === 0 && failed === 0
            ? "Ei varmoja maksuja kohdistettavaksi."
            : `Kohdistettiin ${accepted} maksua.${failed > 0 ? ` ${failed} ei onnistunut, tarkista ne.` : ""}`,
      });
    } catch (error) {
      if (isUnauthorized(error)) {
        redirectToLogin();
        return;
      }
      void hapticNotify("error");
      showToast({ tone: "error", text: errorMessage(error, "Kohdistus epäonnistui") });
    } finally {
      setBulkBusy(false);
      await load();
    }
  }

  const rows = purchaseMatchRows(invoices, suggestions);
  const sureCount = suggestions.filter(isSureSuggestion).length;

  return (
    <div className="stitch-page space-y-6">
      <PullToRefresh onRefresh={() => load()} />
      <PageTitle title="Kohdista ostolaskujen maksut" subtitle="Pankin maksut avoimille ostolaskuille." />

      {status === "loading" && <SkeletonList rows={4} />}
      {status === "error" && (
        <ConnectionNotice error={loadFailure} fallback="Ostolaskujen haku epäonnistui" onRetry={() => void load()} />
      )}

      {status === "ready" && rows.length > 0 && (
        <Button
          type="button"
          variant="primary"
          className="w-full"
          onClick={() => void acceptAllSure()}
          busy={bulkBusy}
          busyLabel="Kohdistetaan…"
          disabled={busyId !== null}
        >
          {sureCount > 0 ? `Hyväksy kaikki varmat (${sureCount})` : "Hyväksy kaikki varmat"}
        </Button>
      )}

      {status === "ready" && rows.length === 0 && (
        <EmptyState
          kind="records"
          icon={Landmark}
          title="Ei avoimia ostolaskuja"
          body="Kun ostolaskuja on maksamatta, niiden pankkimaksut ehdotetaan tässä."
        />
      )}

      {status === "ready" && (
        <PurchaseMatchList rows={rows} busyId={busyId} onAccept={(s) => void accept(s)} onReject={(s) => void reject(s)} />
      )}
    </div>
  );
}
