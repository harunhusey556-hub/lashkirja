import { describe, expect, it } from "vitest";
import { bankRowKey, normaliseRowText, splitNewRows } from "./bank-row-fingerprint";

const row = (date: string | null, amountCents: number, counterparty: string | null = "Spotify") => ({
  date,
  amountCents,
  counterparty,
  message: null,
});

describe("normaliseRowText", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normaliseRowText("  TOINEN  Asiakas Oy. ")).toBe("toinen asiakas oy");
    expect(normaliseRowText("Åström & Pöllö")).toBe("åström pöllö");
    expect(normaliseRowText(null)).toBe("");
  });
});

describe("bankRowKey", () => {
  it("is the same for the same movement however the bank spells the name", () => {
    expect(bankRowKey(row("2026-09-23", -2490, "SPOTIFY"))).toBe(
      bankRowKey(row("2026-09-23", -2490, "Spotify "))
    );
  });

  it("differs by date, amount and counterparty", () => {
    const base = bankRowKey(row("2026-09-23", -2490));
    expect(bankRowKey(row("2026-09-24", -2490))).not.toBe(base);
    expect(bankRowKey(row("2026-09-23", -2491))).not.toBe(base);
    expect(bankRowKey(row("2026-09-23", -2490, "Netflix"))).not.toBe(base);
  });
});

describe("splitNewRows", () => {
  it("keeps everything when nothing is known yet", () => {
    const incoming = [row("2026-09-23", -2490), row("2026-09-24", 123456, "Toinen Asiakas Oy")];
    const { fresh, duplicates } = splitNewRows(incoming, []);
    expect(fresh).toEqual(incoming);
    expect(duplicates).toEqual([]);
  });

  it("skips rows that are already stored", () => {
    const { fresh, duplicates } = splitNewRows(
      [row("2026-09-23", -2490), row("2026-09-30", -500, "Kahvila")],
      [row("2026-09-23", -2490)]
    );
    expect(duplicates).toHaveLength(1);
    expect(fresh.map((r) => r.counterparty)).toEqual(["Kahvila"]);
  });

  it("keeps two genuine identical same-day rows of one file", () => {
    const { fresh, duplicates } = splitNewRows([row("2026-09-23", -450), row("2026-09-23", -450)], []);
    expect(fresh).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it("skips at most as many copies as are already stored", () => {
    const three = [row("2026-09-23", -450), row("2026-09-23", -450), row("2026-09-23", -450)];
    const { fresh, duplicates } = splitNewRows(three, [row("2026-09-23", -450), row("2026-09-23", -450)]);
    expect(duplicates).toHaveLength(2);
    expect(fresh).toHaveLength(1);
  });

  it("is idempotent: the same file twice adds nothing the second time", () => {
    const file = [row("2026-09-23", -450), row("2026-09-23", -450), row("2026-09-24", 1000, "Asiakas")];
    const first = splitNewRows(file, []);
    const second = splitNewRows(file, first.fresh);
    expect(second.fresh).toHaveLength(0);
    expect(second.duplicates).toHaveLength(3);
  });

  it("treats a row the feed delivered without a name as the same movement", () => {
    const { fresh } = splitNewRows([row("2026-09-01", -3590, "Kauppa Oy")], [row("2026-09-01", -3590, null)]);
    expect(fresh).toHaveLength(0);
  });

  it("does not merge rows of different names that share date and amount", () => {
    const { fresh } = splitNewRows([row("2026-09-01", -3590, "Kauppa Oy")], [row("2026-09-01", -3590, "Toinen Oy")]);
    expect(fresh).toHaveLength(1);
  });
});
