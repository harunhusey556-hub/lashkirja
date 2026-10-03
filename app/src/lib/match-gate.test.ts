import { describe, expect, it } from "vitest";
import {
  AMBIGUITY_MARGIN,
  decide,
  gatePair,
  messageReferences,
  nameSimilarity,
  planPairs,
  type GateCandidate,
  type GateRow,
} from "./match-gate";
import { RETIRED_TERMS } from "./glossary";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function row(overrides: Partial<GateRow> = {}): GateRow {
  return {
    id: "row",
    date: d("2026-08-10"),
    amountCents: -4990,
    counterparty: "Puhelinfirma Oy",
    reference: null,
    message: null,
    ...overrides,
  };
}

function kuitti(overrides: Partial<GateCandidate> = {}): GateCandidate {
  return {
    id: "k",
    kind: "kuitti",
    date: d("2026-08-10"),
    amountCents: 4990,
    party: "Puhelinfirma Oy",
    reference: null,
    invoiceNumber: null,
    ...overrides,
  };
}

function lasku(overrides: Partial<GateCandidate> = {}): GateCandidate {
  return {
    id: "l",
    kind: "lasku",
    date: d("2026-08-01"),
    dueDate: d("2026-08-15"),
    amountCents: 12_550,
    party: "Anna Asiakas",
    reference: "1232",
    invoiceNumber: "1023",
    ...overrides,
  };
}

describe("the gate never lets weak evidence through", () => {
  it("date-only: same day, different vendor and amount", () => {
    const verdict = gatePair(row({ counterparty: "Shell" }), kuitti({ amountCents: 9_900 }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.score).toBe(0);
  });

  it("vendor-only: same vendor, different amount", () => {
    expect(gatePair(row(), kuitti({ amountCents: 500 })).eligible).toBe(false);
  });

  it("vendor + date without the amount", () => {
    const verdict = gatePair(row(), kuitti({ amountCents: 500 }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.codes).not.toContain("amount");
  });

  it("amount alone, with no identity signal", () => {
    expect(gatePair(row({ counterparty: "Shell" }), kuitti()).eligible).toBe(false);
  });

  it("amount + name outside the card window (a month later)", () => {
    expect(gatePair(row({ date: d("2026-09-10") }), kuitti()).eligible).toBe(false);
  });

  it("a generic word or a different chain is not a name match", () => {
    expect(nameSimilarity("K-Market Kamppi", "S-MARKET HELSINKI")).toBe(0);
    expect(nameSimilarity("Kahvila Helsinki", "Ravintola Helsinki")).toBe(0);
    expect(nameSimilarity("K-Market Kamppi", "K-MARKET KAMPPI HKI")).toBe(1);
  });
});

describe("the gate lets hard evidence through", () => {
  it("exact amount + reference: eligible and certain, whatever the date", () => {
    const verdict = gatePair(
      row({ reference: "RF18 1232", counterparty: null, date: d("2026-12-30") }),
      lasku({ amountCents: 4_990, party: null })
    );
    expect(verdict).toMatchObject({ eligible: true, certain: true });
    expect(verdict.reasons).toContain("viite täsmää");
    expect(verdict.reasons).toContain("summa sama");
  });

  it("a reference alone for a lasku (partial payment) is eligible but not certain", () => {
    const verdict = gatePair(row({ reference: "1232", amountCents: 5_000, counterparty: null }), lasku());
    expect(verdict).toMatchObject({ eligible: true, certain: false });
  });

  it("a reference printed in the message counts, in groups of five", () => {
    expect(messageReferences("Viite 12345 67897, kiitos").has("1234567897")).toBe(true);
    const verdict = gatePair(
      row({ message: "Lasku viite 12345 67897", amountCents: 12_550, counterparty: null }),
      lasku({ reference: "1234567897" })
    );
    expect(verdict.certain).toBe(true);
  });

  it("exact amount + strong name inside the card window", () => {
    const verdict = gatePair(row({ date: d("2026-08-14") }), kuitti());
    expect(verdict.eligible).toBe(true);
    expect(verdict.reasons).toEqual(["summa sama", "nimi vastaa", "veloitettu 4 päivää oston jälkeen"]);
  });

  it("exact amount + the counterparty IBAN", () => {
    const verdict = gatePair(
      row({ counterparty: "MAKSU", counterpartyIban: "FI21 1234 5600 0007 85" }),
      lasku({ amountCents: 4_990, reference: null, invoiceNumber: null, party: "Toinen nimi", iban: "FI2112345600000785" })
    );
    expect(verdict).toMatchObject({ eligible: true, certain: false });
    expect(verdict.reasons).toContain("tilinumero sama");
  });

  it("the open amount of a part-paid invoice counts as an exact amount", () => {
    const verdict = gatePair(
      row({ amountCents: 7_550, counterparty: "Anna Asiakas", date: d("2026-08-15") }),
      lasku({ openCents: 7_550, reference: null })
    );
    expect(verdict.eligible).toBe(true);
    expect(verdict.reasons[0]).toBe("summa sama kuin avoin osuus");
  });
});

describe("dates rank, they never decide", () => {
  const paid = (date: string) =>
    gatePair(row({ amountCents: 12_550, counterparty: "ANNA ASIAKAS", date: d(date) }), lasku({ reference: null, invoiceNumber: null }));

  it("a late payment within the window is still eligible, scored a little lower", () => {
    const onTime = paid("2026-08-15");
    const late = paid("2026-09-11");
    expect(onTime.eligible).toBe(true);
    expect(late.eligible).toBe(true);
    expect(late.score).toBeLessThan(onTime.score);
    expect(onTime.reasons).toContain("maksettu eräpäivänä");
    expect(late.reasons).toContain("maksettu 27 päivää eräpäivän jälkeen");
  });

  it("an early payment after the invoice date is eligible", () => {
    expect(paid("2026-08-05").reasons).toContain("maksettu 10 päivää ennen eräpäivää");
  });

  it("without a due date the gap is told from the invoice date", () => {
    const sameDay = gatePair(row({ reference: "1232", amountCents: 12_550, date: d("2026-08-01") }), lasku({ dueDate: null }));
    expect(sameDay.reasons).toContain("maksettu laskun päivänä");
    const later = gatePair(row({ reference: "1232", amountCents: 12_550, date: d("2026-08-21") }), lasku({ dueDate: null }));
    expect(later.reasons).toContain("maksettu 20 päivää laskun päiväyksen jälkeen");
  });

  it("paid before the invoice existed, or months after the due date: not without a reference", () => {
    expect(paid("2026-07-01").eligible).toBe(false);
    expect(paid("2026-12-30").eligible).toBe(false);
  });

  it("the Finnish reasons use no retired word (no 'pv')", () => {
    const texts = [paid("2026-09-11"), gatePair(row({ date: d("2026-08-12") }), kuitti())].flatMap((v) => v.reasons);
    for (const text of texts) {
      for (const term of RETIRED_TERMS) expect(term.pattern.test(text), text).toBe(false);
    }
  });
});

describe("ambiguity: equally plausible means no suggestion", () => {
  it("two candidates within the margin: no pick, both listed", () => {
    const decision = decide([
      { id: "a", score: 0.8, certain: false },
      { id: "b", score: 0.8 - AMBIGUITY_MARGIN / 2, certain: false },
    ]);
    expect(decision.pick).toBeNull();
    expect(decision.ambiguous.map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("a certain pair beats an uncertain one; a clear margin decides", () => {
    expect(decide([{ id: "a", score: 0.7, certain: false }, { id: "b", score: 0.86, certain: true }]).pick?.id).toBe("b");
    expect(decide([{ id: "a", score: 0.8, certain: false }, { id: "b", score: 0.7, certain: false }]).pick?.id).toBe("a");
  });

  it("two identical receipts for one row: nothing is suggested", () => {
    const plan = planPairs([row()], [kuitti({ id: "k1" }), kuitti({ id: "k2" })]);
    expect(plan.picks).toEqual([]);
    expect(plan.ambiguousRows.get("row")?.map((p) => p.candidateId).sort()).toEqual(["k1", "k2"]);
  });

  it("one receipt that two rows fit equally: neither row gets it", () => {
    const plan = planPairs([row({ id: "r1" }), row({ id: "r2" })], [kuitti()]);
    expect(plan.picks).toEqual([]);
  });

  it("monthly look-alikes: only the receipt inside the window is picked", () => {
    const plan = planPairs([row({ date: d("2026-09-11") })], [kuitti({ id: "aug" }), kuitti({ id: "sep", date: d("2026-09-10") })]);
    expect(plan.picks.map((p) => p.candidateId)).toEqual(["sep"]);
  });
});
