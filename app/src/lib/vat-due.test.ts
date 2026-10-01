import { describe, expect, it } from "vitest";
import { nextVatDue, vatDueFor, vatPeriodEndingIn, vatPeriodKey, vatPeriodKindOf } from "./vat-deadline";
import {
  vatAmountToPay,
  vatChangedNote,
  vatChangedSinceFiling,
  vatDueAmount,
  vatDueDate,
  vatDueSecondary,
  vatFileStepText,
  vatFiledNote,
  vatFilingState,
  vatNothingToPay,
  vatPayStepText,
  vatPendingNote,
  vatStateLabel,
  type VatDueFigures,
} from "./vat-due";

const august: VatDueFigures = { amount: 159.38, isRefund: false, filing: null, pendingReceiptCount: 0 };

describe("next VAT due (TF-01)", () => {
  it("in late September a monthly filer's next return is August, due 12.10.", () => {
    const due = nextVatDue(new Date("2026-09-30T10:00:00Z"), "month");
    expect(due.key).toBe("2026-08");
    expect(due.label).toBe("Elokuu 2026");
    expect(due.dueIso).toBe("2026-10-12");
    expect(due.queryKey).toBe("2026-08");
  });

  it("the row reads the same on every screen", () => {
    const due = nextVatDue(new Date("2026-09-30T10:00:00Z"), "month");
    expect(vatDueSecondary(due, august)).toBe("Elokuu 2026 · eräpäivä 12.10. · Ilmoittamatta");
    expect(vatDueAmount(august)).toBe("159,38 €");
    expect(vatDueSecondary(due, null)).toBe("Elokuu 2026 · eräpäivä 12.10.");
  });

  it("a refund says so and needs no payment", () => {
    const due = vatDueFor({ kind: "month", year: 2026, month: 9 });
    const refund = { ...august, isRefund: true, filing: { filedAt: "2026-10-05T00:00:00Z", paidAt: null, filedAmount: -159.38 } };
    expect(vatDueSecondary(due, refund)).toBe("Syyskuu 2026 · palautus · eräpäivä 12.11. · Ilmoitettu");
  });

  it("names the filing state", () => {
    expect(vatFilingState(null)).toBe("open");
    expect(vatFilingState({ filedAt: "x", paidAt: null, filedAmount: 1 })).toBe("filed");
    expect(vatFilingState({ filedAt: "x", paidAt: "y", filedAmount: 1 })).toBe("paid");
    expect(vatStateLabel("filed", false)).toBe("Ilmoitettu, maksamatta");
    expect(vatStateLabel("paid", false)).toBe("Maksettu");
  });

  it("keys and kinds", () => {
    expect(vatPeriodKey({ kind: "quarter", year: 2026, quarter: 3 })).toBe("2026-Q3");
    expect(vatPeriodKey({ kind: "year", year: 2026 })).toBe("2026");
    expect(vatDueFor({ kind: "year", year: 2026 }).queryKey).toBe("2026");
    expect(vatPeriodKindOf("quarter")).toBe("quarter");
    expect(vatPeriodKindOf("whatever")).toBe("month");
    expect(vatPeriodKindOf(null)).toBe("month");
  });

  it("finds the period a month closes", () => {
    expect(vatPeriodEndingIn("2026-08", "month")).toEqual({ kind: "month", year: 2026, month: 8 });
    expect(vatPeriodEndingIn("2026-08", "quarter")).toBeNull();
    expect(vatPeriodEndingIn("2026-09", "quarter")).toEqual({ kind: "quarter", year: 2026, quarter: 3 });
    expect(vatPeriodEndingIn("2026-11", "year")).toBeNull();
    expect(vatPeriodEndingIn("2026-12", "year")).toEqual({ kind: "year", year: 2026 });
  });
});

describe("what the VAT figure does not contain yet (TF-11)", () => {
  it("says how many pending receipts may change it", () => {
    expect(vatPendingNote(august)).toBeNull();
    expect(vatPendingNote({ ...august, pendingReceiptCount: 1 })).toBe("1 kuitti odottaa hyväksyntää. Se voi muuttaa ALV:tä.");
    expect(vatPendingNote({ ...august, pendingReceiptCount: 3 })).toBe("3 kuittia odottaa hyväksyntää. Ne voivat muuttaa ALV:tä.");
  });

  it("notices a figure that moved after filing", () => {
    const filed = { filedAt: "x", paidAt: null, filedAmount: 159.38 };
    expect(vatChangedSinceFiling({ ...august, filing: filed })).toBe(false);
    expect(vatChangedSinceFiling({ ...august, amount: 170, filing: filed })).toBe(true);
    expect(vatChangedSinceFiling({ ...august, isRefund: true, amount: 159.38, filing: filed })).toBe(true);
  });
});

describe("filing card sentences (F73)", () => {
  const plain = (value: string) => value.replace(/ /g, " ");

  it("never doubles the full stop after a due date like 12.10.", () => {
    expect(vatFileStepText("2026-10-12")).toBe("Kirjoita kentät tältä sivulta ja lähetä ilmoitus viimeistään 12.10.");
    expect(plain(vatPayStepText(159.38, "2026-11-12")!)).toBe("Maksa 159,38 € viimeistään 12.11.");
    for (const text of [
      vatFileStepText("2026-10-12"),
      vatPayStepText(159.38, "2026-11-12"),
      vatFiledNote("5.10.2026", 159.38, "2026-10-12", false),
      vatFiledNote("", 159.38, "2026-10-12", false),
    ]) {
      expect(text).not.toContain("..");
    }
  });

  it("says nothing about paying a zero return or a refund", () => {
    expect(vatNothingToPay({ amount: 0, isRefund: false })).toBe(true);
    expect(vatNothingToPay({ amount: 12.5, isRefund: true })).toBe(true);
    expect(vatNothingToPay({ amount: 12.5, isRefund: false })).toBe(false);
    expect(vatPayStepText(0, "2026-07-13")).toBeNull();
    expect(vatFiledNote("5.10.2026", 0, "2026-10-12", true)).toBe("Ilmoitettu 5.10.2026.");
    expect(plain(vatFiledNote("5.10.2026", 159.38, "2026-10-12", false))).toBe("Ilmoitettu 5.10.2026. Maksa 159,38 € viimeistään 12.10.");
  });

  it("a filed zero return is done, not waiting for a payment that cannot be made", () => {
    expect(vatStateLabel("filed", true)).toBe("Ilmoitettu");
    const zero: VatDueFigures = { amount: 0, isRefund: false, filing: { filedAt: "2026-10-05", paidAt: null, filedAmount: 0 }, pendingReceiptCount: 0 };
    const due = nextVatDue(new Date("2026-09-30T10:00:00Z"), "month");
    expect(vatDueSecondary(due, zero)).toBe("Elokuu 2026 · eräpäivä 12.10. · Ilmoitettu");
  });
});

describe("a return that changed after filing is flagged everywhere the row is shown (F66)", () => {
  const due = vatDueFor({ kind: "month", year: 2026, month: 8 });
  const filed = { filedAt: "2026-10-05T00:00:00Z", paidAt: null, filedAmount: 232.88 };
  const plain = (text: string | null) => (text ?? "").replace(/ /g, " ");
  const changed: VatDueFigures = { amount: 212.56, isRefund: false, filing: filed, pendingReceiptCount: 0 };

  it("adds the change to the shared row words, filed or paid", () => {
    expect(vatDueSecondary(due, changed)).toBe(
      "Elokuu 2026 · eräpäivä 12.10. · Ilmoitettu, maksamatta · muuttunut ilmoituksen jälkeen"
    );
    expect(vatDueSecondary(due, { ...changed, filing: { ...filed, paidAt: "2026-10-10T00:00:00Z" } })).toBe(
      "Elokuu 2026 · eräpäivä 12.10. · Maksettu · muuttunut ilmoituksen jälkeen"
    );
  });

  it("leaves an unchanged return alone", () => {
    expect(vatDueSecondary(due, { ...changed, amount: 232.88 })).toBe(
      "Elokuu 2026 · eräpäivä 12.10. · Ilmoitettu, maksamatta"
    );
    expect(vatChangedNote({ ...changed, amount: 232.88 })).toBeNull();
    expect(vatChangedNote(null)).toBeNull();
  });

  it("names both the filed and the current figure", () => {
    expect(plain(vatChangedNote(changed))).toBe(
      "Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu 232,88 €, nyt 212,56 €."
    );
    const refund = { ...changed, isRefund: true, amount: 20.8, filing: { ...filed, filedAmount: 10 } };
    expect(plain(vatChangedNote(refund))).toBe(
      "Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu 10,00 €, nyt palautus 20,80 €."
    );
  });

  it("asks for the filed amount once a return is filed, the live one before", () => {
    expect(vatAmountToPay(changed)).toBe(232.88);
    expect(vatAmountToPay({ ...changed, filing: null })).toBe(212.56);
  });
});

describe("a filed return owes what was filed (F66)", () => {
  it("is not paid-off by a refund that appeared after filing", () => {
    const filedOwing = { filedAt: "2026-10-05T00:00:00Z", paidAt: null, filedAmount: 232.88 };
    expect(vatNothingToPay({ amount: 5, isRefund: true, filing: filedOwing })).toBe(false);
    expect(vatNothingToPay({ amount: 5, isRefund: true, filing: null })).toBe(true);
    expect(vatNothingToPay({ amount: 50, isRefund: false, filing: { ...filedOwing, filedAmount: -20 } })).toBe(true);
    expect(vatNothingToPay({ amount: 0, isRefund: false })).toBe(true);
  });
});

describe("a deadline in a later year names the year (F13)", () => {
  it("shows the year for a yearly return and for November, not for August", () => {
    expect(vatDueDate("2027-03-01", 2026)).toBe("1.3.2027");
    expect(vatDueDate("2027-01-12", 2026)).toBe("12.1.2027");
    expect(vatDueDate("2026-10-12", 2026)).toBe("12.10.");
    expect(vatDueDate("2026-10-12")).toBe("12.10.");
  });

  it("puts it in the row text every screen shares", () => {
    const yearly = vatDueFor({ kind: "year", year: 2026 });
    expect(vatDueSecondary(yearly, null)).toBe("2026 · eräpäivä 1.3.2027");
    expect(vatDueSecondary(vatDueFor({ kind: "month", year: 2026, month: 11 }), null)).toBe(
      "Marraskuu 2026 · eräpäivä 12.1.2027"
    );
  });
});
