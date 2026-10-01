import { describe, expect, it } from "vitest";
import { formatEur } from "./format";
import { KOTI_BANK_COPY, kotiBankRow } from "./koti-bank";

const base = { totalBalance: 1234.56, accountCount: 1, needsAttention: 0 };

describe("OWN-18: Koti's Pankkitilit row", () => {
  it("a connected bank shows its balance and no Yhdistä pill", () => {
    const row = kotiBankRow({ ...base, state: "connected", hasBalance: true });
    expect(row.amount).toBe(formatEur(1234.56));
    expect(row.secondary).toBe("1 tili");
    expect(row.pill).toBeNull();
  });

  it("a connected account without a reported balance never shows 0 €", () => {
    const row = kotiBankRow({ ...base, totalBalance: 0, state: "connected", hasBalance: false });
    expect(row.amount).toBeUndefined();
    expect(row.secondary).toBe(`1 tili · ${KOTI_BANK_COPY.noBalance}`);
  });

  it("an ended consent asks to connect again instead of saying there is no bank", () => {
    const row = kotiBankRow({ ...base, accountCount: 0, totalBalance: 0, state: "reconnect", reconnectBank: "S-Pankki" });
    expect(row.secondary).toBe("Yhteys vanhentunut — yhdistä uudelleen");
    expect(row.warn).toBe(true);
    expect(row.pill?.ariaLabel).toBe("Yhdistä pankki uudelleen");
    expect(row.secondary).not.toBe(KOTI_BANK_COPY.none);
  });

  it("a consent with no account in bookkeeping asks to choose accounts", () => {
    const row = kotiBankRow({ ...base, accountCount: 0, state: "unscoped" });
    expect(row.secondary).toBe(KOTI_BANK_COPY.unscoped);
    expect(row.pill?.label).toBe("Valitse");
  });

  it("nothing connected keeps the Yhdistä pill", () => {
    const row = kotiBankRow({ ...base, accountCount: 0, totalBalance: 0, state: "none" });
    expect(row.secondary).toBe(KOTI_BANK_COPY.none);
    expect(row.pill?.label).toBe("Yhdistä");
  });

  it("a dashboard cached before OWN-18 still reads by its account count", () => {
    expect(kotiBankRow({ ...base }).pill).toBeNull();
    expect(kotiBankRow({ ...base, accountCount: 0 }).secondary).toBe(KOTI_BANK_COPY.none);
    expect(kotiBankRow(null).secondary).toBe(KOTI_BANK_COPY.none);
  });
});
