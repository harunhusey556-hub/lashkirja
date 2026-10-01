import { describe, expect, it } from "vitest";
import {
  checkStepState,
  monthCloseButton,
  monthCloseSubtitle,
  monthCloseWarnings,
  type MonthCloseFacts,
} from "./month-close";

const settled: MonthCloseFacts = {
  ended: true,
  locked: false,
  blocking: 0,
  hasContent: true,
  hasStatement: true,
  vat: null,
};

describe("a step is ticked only when there was something to check (F10)", () => {
  it("is done only with items and nothing open", () => {
    expect(checkStepState(0, true)).toBe("done");
    expect(checkStepState(2, true)).toBe("open");
    expect(checkStepState(0, false)).toBe("none");
  });
});

describe("the month close verdict (F10, F66)", () => {
  it("says Kaikki kirjattu only for a month with content, a statement and nothing open", () => {
    expect(monthCloseSubtitle(settled)).toBe("Kaikki kirjattu. Voit sulkea kuukauden.");
  });

  it("never says Kaikki kirjattu for an empty or new-account month", () => {
    const empty = { ...settled, hasContent: false, hasStatement: false };
    expect(monthCloseSubtitle(empty)).toBe("Ei kirjattavaa tässä kuussa.");
    expect(monthCloseSubtitle(empty)).not.toMatch(/Kaikki kirjattu/);
  });

  it("does not call a month with receipts but no tiliote fully recorded", () => {
    expect(monthCloseSubtitle({ ...settled, hasStatement: false })).toBe("Tiliote puuttuu. Tuo se ennen sulkemista.");
  });

  it("calls a running or future month unfinished, never ready", () => {
    expect(monthCloseSubtitle({ ...settled, ended: false })).toBe("Kuukausi on vielä kesken.");
  });

  it("counts open items before anything else", () => {
    expect(monthCloseSubtitle({ ...settled, blocking: 1 })).toBe("1 asia kesken");
    expect(monthCloseSubtitle({ ...settled, blocking: 3 })).toBe("3 asiaa kesken");
  });

  it("does not say Kaikki kirjattu while the VAT return is not filed", () => {
    const vat = { state: "open" as const, done: false, changedSinceFiling: false, nothingToPay: false };
    expect(monthCloseSubtitle({ ...settled, vat })).toBe("Kirjaukset on tehty. ALV-ilmoitus on vielä tekemättä.");
    expect(monthCloseSubtitle({ ...settled, vat: { ...vat, state: "filed" } })).toBe(
      "Kirjaukset on tehty. ALV on ilmoitettu, mutta ei vielä maksettu."
    );
  });

  it("flags a return whose figures changed after filing, filed or paid", () => {
    for (const state of ["filed", "paid"] as const) {
      const vat = { state, done: false, changedSinceFiling: true, nothingToPay: false };
      expect(monthCloseSubtitle({ ...settled, vat })).toBe("ALV-luvut ovat muuttuneet ilmoituksen jälkeen. Tarkista ne.");
      expect(monthCloseWarnings({ ...settled, vat })).toContain("ALV-luvut ovat muuttuneet ilmoituksen jälkeen.");
    }
  });

  it("says Kaikki kirjattu once the return is paid and unchanged", () => {
    const vat = { state: "paid" as const, done: true, changedSinceFiling: false, nothingToPay: false };
    expect(monthCloseSubtitle({ ...settled, vat })).toBe("Kaikki kirjattu. Voit sulkea kuukauden.");
  });

  it("keeps the closed month's line", () => {
    expect(monthCloseSubtitle({ ...settled, locked: true, hasContent: false })).toBe("Kuukausi on suljettu.");
  });
});

describe("the close button and its confirm text", () => {
  it("is off for a month that has not ended or holds nothing", () => {
    expect(monthCloseButton({ ended: false, blocking: 0, hasContent: true }).disabled).toBe(true);
    const empty = monthCloseButton({ ended: true, blocking: 0, hasContent: false });
    expect(empty.disabled).toBe(true);
    expect(empty.reason).toBe("Tässä kuussa ei ole kirjattavaa.");
    expect(monthCloseButton({ ended: true, blocking: 0, hasContent: true }).disabled).toBe(false);
  });

  it("warns about a missing tiliote and about each VAT state", () => {
    expect(monthCloseWarnings({ ...settled, hasStatement: false })).toEqual(["Tiliotetta ei ole tuotu."]);
    const open = { state: "open" as const, done: false, changedSinceFiling: false, nothingToPay: false };
    expect(monthCloseWarnings({ ...settled, vat: open })).toEqual(["ALV-ilmoitusta ei ole merkitty annetuksi."]);
    expect(monthCloseWarnings({ ...settled, vat: { ...open, state: "filed" } })).toEqual([
      "ALV:ta ei ole merkitty maksetuksi.",
    ]);
    expect(monthCloseWarnings(settled)).toEqual([]);
  });
});
