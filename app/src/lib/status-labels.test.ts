import { describe, expect, it } from "vitest";
import {
  PURCHASE_STATUS,
  RECEIPT_MATCH_STATUS,
  SALES_STATUS,
  STATEMENT_TX_STATUS,
  receiptMatchStatusKey,
  statementTxStatusKey,
} from "./status-labels";

describe("status labels", () => {
  it("keeps the Finnish sales invoice words the app already shows", () => {
    expect(Object.fromEntries(Object.entries(SALES_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
      draft: "Luonnos", sent: "Lähetetty", overdue: "Myöhässä", paid: "Maksettu", credited: "Hyvitetty",
    });
    expect(SALES_STATUS.overdue.tone).toBe("danger");
    expect(SALES_STATUS.paid.tone).toBe("success");
  });
  it("keeps the purchase invoice words", () => {
    expect(PURCHASE_STATUS.open.label).toBe("Avoin");
    expect(PURCHASE_STATUS.cancelled.label).toBe("Mitätöity");
    expect(PURCHASE_STATUS.overdue.tone).toBe("danger");
  });
  it("keeps the receipt match words the kuitit list already showed", () => {
    expect(Object.fromEntries(Object.entries(RECEIPT_MATCH_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
      linked: "Linkitetty",
      suggested: "Ehdotus",
      candidates: "Ehdotuksia",
      unlinked: "Ei linkitystä",
    });
    expect(RECEIPT_MATCH_STATUS.linked.tone).toBe("success");
    expect(RECEIPT_MATCH_STATUS.unlinked.tone).toBe("neutral");
  });
  it("resolves a receipt's match status key the same way the old inline ternary did", () => {
    expect(receiptMatchStatusKey({ status: "linked" })).toBe("linked");
    expect(receiptMatchStatusKey({ status: "suggested" })).toBe("suggested");
    expect(receiptMatchStatusKey({ status: "unlinked", matchCandidates: [{}] })).toBe("candidates");
    expect(receiptMatchStatusKey({ status: "unlinked", matchCandidates: [] })).toBe("unlinked");
    expect(receiptMatchStatusKey({ status: "unlinked" })).toBe("unlinked");
  });
  it("keeps the statement transaction document-state words the tiliote detail already showed", () => {
    expect(Object.fromEntries(Object.entries(STATEMENT_TX_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
      linked: "Linkitetty",
      suggested: "Ehdotus",
      ignored: "Ei tarvita",
      palkka: "Palkka",
      missing: "Puuttuu",
    });
    expect(STATEMENT_TX_STATUS.linked.tone).toBe("success");
    expect(STATEMENT_TX_STATUS.missing.tone).toBe("danger");
  });
  it("resolves a statement transaction's status key the same way the old MatchBadge did", () => {
    expect(statementTxStatusKey({ type: "palkka", matchStatus: "unmatched" })).toBe("palkka");
    expect(statementTxStatusKey({ type: "oma_siirto", matchStatus: "unmatched" })).toBeNull();
    expect(statementTxStatusKey({ type: "meno", matchStatus: "confirmed" })).toBe("linked");
    expect(statementTxStatusKey({ type: "meno", matchStatus: "suggested" })).toBe("suggested");
    expect(statementTxStatusKey({ type: "meno", matchStatus: "ignored" })).toBe("ignored");
    expect(statementTxStatusKey({ type: "meno", matchStatus: "unmatched" })).toBe("missing");
  });
});
