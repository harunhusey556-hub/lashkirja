import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ prisma: {} }));

import { combineBankPosition, combineTrend, type PositionConnection } from "./bank-position";

const NOW = new Date("2026-10-01T12:00:00Z");

function connection(overrides: Partial<PositionConnection> = {}): PositionConnection {
  return {
    id: "c1",
    aspspName: "S-Pankki",
    aspspCountry: "FI",
    status: "active",
    validUntil: new Date("2027-01-01T00:00:00Z"),
    lastError: null,
    sessionIdEnc: "enc",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    accounts: [],
    ...overrides,
  };
}

describe("combineTrend", () => {
  it("plots months where one series has data; a series without statements carries its opening value", () => {
    const withData = {
      openingCents: 100_00,
      points: [
        { month: "2026-08", cents: 200_00 },
        { month: "2026-09", cents: 300_00 },
        { month: "2026-10", cents: 400_00 },
      ],
    };
    const handAddedNoStatements = { openingCents: 50_00, points: [] };
    expect(combineTrend([withData, handAddedNoStatements], "2026-10", 6)).toEqual([
      { month: "2026-08", balance: 250 },
      { month: "2026-09", balance: 350 },
      { month: "2026-10", balance: 450 },
    ]);
  });

  it("a gap carries the series' last known value", () => {
    const a = { openingCents: 0, points: [{ month: "2026-08", cents: 10_00 }] };
    const b = {
      openingCents: 0,
      points: [
        { month: "2026-07", cents: 1_00 },
        { month: "2026-09", cents: 3_00 },
      ],
    };
    expect(combineTrend([a, b], "2026-09", 3)).toEqual([
      { month: "2026-07", balance: 1 },
      { month: "2026-08", balance: 11 },
      { month: "2026-09", balance: 13 },
    ]);
  });

  it("is null with no series or under two plotted months", () => {
    expect(combineTrend([], "2026-10", 6)).toBeNull();
    expect(combineTrend([{ openingCents: 5_00, points: [] }], "2026-10", 6)).toBeNull();
    expect(combineTrend([{ openingCents: 0, points: [{ month: "2026-10", cents: 1 }] }], "2026-10", 6)).toBeNull();
  });
});

describe("combineBankPosition reconnect", () => {
  it("an old ended consent without accounts does not ask to reconnect once the same bank is connected again", () => {
    const old = connection({ id: "old", status: "error", createdAt: new Date("2026-06-01T00:00:00Z"), accounts: [] });
    const fresh = connection({
      id: "new",
      accounts: [
        { id: "a", iban: "FI2112345600000785", label: null, currency: "EUR", inScope: true, balanceCents: 100, balanceAt: null },
      ],
    });
    const position = combineBankPosition([], [old, fresh], NOW);
    expect(position.state).toBe("connected");
    expect(position.reconnectBank).toBeNull();
  });

  it("still asks to reconnect when only another bank is connected", () => {
    const old = connection({ id: "old", status: "expired", createdAt: new Date("2026-06-01T00:00:00Z"), accounts: [] });
    const other = connection({ id: "other", aspspName: "Nordea" });
    const position = combineBankPosition([], [old, other], NOW);
    expect(position.state).toBe("reconnect");
    expect(position.reconnectBank).toBe("S-Pankki");
  });

  it("the same bank name in another country does not supersede", () => {
    const old = connection({ id: "old", status: "expired", createdAt: new Date("2026-06-01T00:00:00Z") });
    const sweden = connection({ id: "se", aspspCountry: "SE" });
    expect(combineBankPosition([], [old, sweden], NOW).state).toBe("reconnect");
  });

  it("an older usable consent does not supersede a newer one that ended", () => {
    const older = connection({ id: "older", createdAt: new Date("2026-01-01T00:00:00Z") });
    const ended = connection({ id: "ended", status: "expired", createdAt: new Date("2026-08-01T00:00:00Z") });
    expect(combineBankPosition([], [older, ended], NOW).state).toBe("reconnect");
  });
});
