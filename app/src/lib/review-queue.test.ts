import { describe, expect, it } from "vitest";
import {
  approvalFailureText,
  queueTotalText,
  retryableFailureIds,
  splitApprovable,
} from "./review-queue";

const eur = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;

const row = (id: string, vendor: string | null, totalAmount: number | null) => ({
  id,
  vendor,
  totalAmount,
});

describe("splitApprovable", () => {
  it("keeps receipts without an amount or a vendor out of the one-tap approval (F15)", () => {
    const { ready, incomplete } = splitApprovable([
      row("a", "Kahvila", 12.5),
      row("b", "Kahvila", null),
      row("c", null, 5),
      row("d", "Kahvila", 0),
    ]);
    expect(ready.map((r) => r.id)).toEqual(["a", "d"]);
    expect(incomplete.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("names the gaps of each incomplete row", () => {
    const { incomplete } = splitApprovable([row("b", "Kahvila", null), row("c", "", null)]);
    expect(incomplete[0].gaps).toEqual(["amount"]);
    expect(incomplete[1].gaps).toEqual(["amount", "vendor"]);
  });
});

describe("queueTotalText", () => {
  it("sums the known totals and says how many have none", () => {
    expect(queueTotalText([row("a", "X", 10), row("b", "X", 2.5)], eur)).toBe("Yhteensä 12,50 €");
    expect(queueTotalText([row("a", "X", 10), row("b", "X", null)], eur)).toBe(
      "Yhteensä 10,00 € + 1 ilman summaa"
    );
  });

  it("shows a dash, not 0,00 €, when no receipt has a total", () => {
    expect(queueTotalText([row("a", "X", null), row("b", "X", null)], eur)).toBe("Yhteensä –");
    expect(queueTotalText([], eur)).toBe("Yhteensä –");
  });
});

describe("approvalFailureText", () => {
  it("is calm when everything went through", () => {
    expect(approvalFailureText(3, [])).toBe("Hyväksyttiin 3.");
  });

  it("names the refusal instead of a bare count", () => {
    const text = approvalFailureText(0, [
      { id: "a", error: "Kuitista puuttuu summa. Lisää summa ennen hyväksyntää." },
      { id: "b", error: "Kuitista puuttuu summa. Lisää summa ennen hyväksyntää." },
    ]);
    expect(text).toBe(
      "2 kuittia ei voitu hyväksyä: Kuitista puuttuu summa. Lisää summa ennen hyväksyntää."
    );
  });

  it("keeps what was approved and lists each distinct reason once", () => {
    expect(
      approvalFailureText(2, [
        { id: "a", error: "Kuitin kuukausi on suljettu." },
        { id: "b", error: "Kuitti on jo käsitelty." },
      ])
    ).toBe("Hyväksyttiin 2. 2 kuittia ei voitu hyväksyä: Kuitin kuukausi on suljettu. Kuitti on jo käsitelty.");
    expect(approvalFailureText(0, [{ id: "a", error: "Kuitin kuukausi on suljettu." }])).toBe(
      "Yhtä kuittia ei voitu hyväksyä: Kuitin kuukausi on suljettu."
    );
  });
});

describe("retryableFailureIds", () => {
  it("offers a retry only for failures that can change on a second try", () => {
    expect(
      retryableFailureIds([
        { id: "a", error: "Kuitista puuttuu summa. Lisää summa ennen hyväksyntää." },
        { id: "b", error: "Kuitin kuukausi on suljettu." },
        { id: "c", error: "Kuitti on jo käsitelty." },
        { id: "d", error: "Kuittia ei löytynyt" },
        { id: "e", error: "Jokin odottamaton virhe" },
      ])
    ).toEqual(["e"]);
  });
});
