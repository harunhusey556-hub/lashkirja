import { describe, expect, it } from "vitest";
import {
  approveSuggestionsLabel,
  bestCandidate,
  bulkConfirmTitle,
  bulkOutcomeText,
  planBulk,
  runLimited,
} from "./bank-bulk";
import { feedRows } from "./bank-feed";
import type { MatchCandidate, StatementData, StatementTransaction } from "./statement-client";

function tx(id: string, over: Partial<StatementTransaction> = {}): StatementTransaction {
  return {
    id,
    date: "2026-09-10T00:00:00.000Z",
    counterparty: `Kauppa ${id}`,
    amount: -10,
    reference: null,
    message: null,
    type: "meno",
    matchStatus: "unmatched",
    receiptId: null,
    receipt: null,
    suggestedReceiptId: null,
    suggestedReceipt: null,
    ...over,
  };
}

const receipt = (id: string, source?: string) => ({ id, vendor: "K", totalAmount: 10, date: null, source });
const candidate = (id: string, score: number): MatchCandidate => ({ score, reasons: [], receipt: receipt(id) });

function rowsOf(...transactions: StatementTransaction[]) {
  const statements: StatementData[] = [
    {
      id: "s1",
      fileName: "s.csv",
      fileType: "csv",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      periodMonth: "2026-09",
      bankAccountId: null,
      bankAccount: null,
      transactions,
      totals: { income: 0, expenses: 0, transfers: 0, net: 0, txCount: transactions.length },
    },
  ];
  return feedRows(statements);
}

describe("planBulk", () => {
  it("sorts the selection into what each action will send", () => {
    const rows = rowsOf(
      tx("sug", { matchStatus: "suggested", suggestedReceiptId: "r1", suggestedReceipt: receipt("r1") }),
      tx("sale", {
        amount: 50,
        type: "tulo",
        matchStatus: "suggested",
        suggestedReceiptId: "r2",
        suggestedReceipt: receipt("r2", "auto_income"),
      }),
      tx("miss", { matchCandidates: [candidate("r3", 40), candidate("r4", 90)] }),
      tx("linked", { matchStatus: "confirmed", receiptId: "r5", receipt: receipt("r5") }),
      tx("oma", { type: "oma_siirto" }),
      tx("ign", { matchStatus: "ignored" })
    );
    const plan = planBulk(rows);
    expect(plan.confirmPairs).toEqual([{ transactionId: "sug", receiptId: "r1" }]);
    expect(plan.saleApprovals.map((item) => item.receiptId)).toEqual(["r2"]);
    expect(plan.rejectable.map((item) => item.row.id).sort()).toEqual(["sale", "sug"]);
    expect(plan.proposals.map((item) => [item.row.id, item.candidate.id])).toEqual([["miss", "r4"]]);
    // A documented row and an existing own transfer are not offered "Oma siirto".
    expect(plan.transferable.map((row) => row.id).sort()).toEqual(["ign", "miss", "sale", "sug"]);
  });

  it("lets one kuitti document one row: the second row proposing it gets no proposal", () => {
    const rows = rowsOf(
      tx("a", { matchCandidates: [candidate("r1", 80)] }),
      tx("b", { matchCandidates: [candidate("r1", 70)] })
    );
    expect(planBulk(rows).proposals).toHaveLength(1);
  });

  it("is empty for an empty selection", () => {
    const plan = planBulk([]);
    expect(plan.confirmPairs).toHaveLength(0);
    expect(plan.proposals).toHaveLength(0);
  });
});

describe("bestCandidate", () => {
  it("takes the highest score whatever the order", () => {
    expect(bestCandidate({ matchCandidates: [candidate("a", 10), candidate("b", 70), candidate("c", 30)] })?.receipt.id).toBe("b");
    expect(bestCandidate({ matchCandidates: [] })).toBeNull();
    expect(bestCandidate({})).toBeNull();
  });
});

describe("labels", () => {
  it("names the count in every confirmation", () => {
    expect(approveSuggestionsLabel(3)).toBe("Hyväksy ehdotukset (3)");
    expect(bulkConfirmTitle("approve", 1)).toBe("Hyväksytäänkö 1 ehdotus?");
    expect(bulkConfirmTitle("approve", 12)).toBe("Hyväksytäänkö 12 ehdotusta?");
    expect(bulkConfirmTitle("reject", 4)).toContain("4");
    expect(bulkConfirmTitle("transfer", 2)).toBe("Merkitäänkö 2 tapahtumaa omaksi siirroksi?");
    expect(bulkConfirmTitle("match", 7)).toBe("Kohdistetaanko 7 tapahtumaa?");
  });

  it("says plainly what happened", () => {
    expect(bulkOutcomeText("Hyväksyttiin", 3, 0)).toBe("Hyväksyttiin 3.");
    expect(bulkOutcomeText("Hyväksyttiin", 2, 1)).toBe("Hyväksyttiin 2, epäonnistui 1.");
    expect(bulkOutcomeText("Hyväksyttiin", 0, 2)).toContain("Mikään ei onnistunut");
  });
});

describe("runLimited", () => {
  it("never runs more than the limit at once, reports every outcome in input order and never rejects", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (n % 3 === 0) throw new Error(`no ${n}`);
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.done).toEqual([1, 2, 4, 5, 7]);
    expect(result.failed.map((entry) => entry.item)).toEqual([3, 6]);
  });

  it("handles an empty list", async () => {
    expect(await runLimited([], 4, async () => {})).toEqual({ done: [], failed: [] });
  });
});
