import { describe, expect, it } from "vitest";
import { BANK_COPY, accountSubline, bankState, fetchedWhen, type BankConnectionSummary } from "./bank-status";

const NOW = new Date(2026, 8, 29, 14, 30);

function connection(patch: Partial<BankConnectionSummary> = {}): BankConnectionSummary {
  return {
    id: "c1",
    aspspName: "Nordea",
    aspspCountry: "FI",
    aspspLogo: null,
    psuType: "business",
    status: "active",
    validUntil: new Date(2026, 11, 1).toISOString(),
    lastSyncAt: null,
    lastSuccessAt: new Date(2026, 8, 29, 8, 5).toISOString(),
    lastError: null,
    accounts: [],
    ...patch,
  };
}

describe("bankState", () => {
  it("is unconfigured when the server has it switched off", () => {
    const state = bankState({ enabled: false, ready: false, connections: [] }, NOW);
    expect(state.kind).toBe("unconfigured");
    expect(state.title).toBe("Pankkiyhteys ei ole vielä käytössä");
  });

  it("is unconfigured when switched on but incomplete, and never repeats a setting name", () => {
    const state = bankState({ enabled: true, ready: false, connections: [] }, NOW);
    expect(state.kind).toBe("unconfigured");
    expect(`${state.title} ${state.line}`).not.toMatch(/ENABLEBANKING|APP_ID|KEY_FILE/);
  });

  it("asks to connect when ready with no connection", () => {
    const state = bankState({ enabled: true, ready: true, connections: [] }, NOW);
    expect(state).toMatchObject({ kind: "none", title: "Yhdistä pankki", line: "Ei yhdistetty" });
  });

  it("names the bank and today's fetch time", () => {
    const state = bankState({ enabled: true, ready: true, connections: [connection()] }, NOW);
    expect(state).toMatchObject({ kind: "connected", line: "Nordea yhdistetty, haettu 8.05" });
  });

  it("flags a connection that must be confirmed again", () => {
    const state = bankState(
      { enabled: true, ready: true, connections: [connection({ status: "expired" })] },
      NOW
    );
    expect(state.kind).toBe("attention");
    expect(state.line).toBe("Nordea: vaatii uuden vahvistuksen");
  });

  it("joins two banks and counts three", () => {
    const two = bankState(
      { enabled: true, ready: true, connections: [connection(), connection({ id: "c2", aspspName: "OP" })] },
      NOW
    );
    expect(two.line).toMatch(/^Nordea ja OP yhdistetty/);
    const three = bankState(
      {
        enabled: true,
        ready: true,
        connections: [connection(), connection({ id: "c2", aspspName: "OP" }), connection({ id: "c3", aspspName: "S-Pankki" })],
      },
      NOW
    );
    expect(three.line).toMatch(/^3 pankkia yhdistetty/);
  });

  it("says a pending consent is still waiting", () => {
    const state = bankState(
      { enabled: true, ready: true, connections: [connection({ status: "pending", lastSuccessAt: null })] },
      NOW
    );
    expect(state.line).toBe("Nordea: odottaa vahvistusta");
  });
});

describe("fetchedWhen", () => {
  it("shows the time today, the date otherwise", () => {
    expect(fetchedWhen(new Date(2026, 8, 29, 9, 0).toISOString(), NOW)).toBe("9.00");
    expect(fetchedWhen(new Date(2026, 8, 28, 9, 0).toISOString(), NOW)).toBe("28.9.");
    expect(fetchedWhen(new Date(2025, 11, 31, 9, 0).toISOString(), NOW)).toBe("31.12.2025");
  });
});

describe("F16 / G33: the not-in-use copy is written for the person using the app", () => {
  it("names no server, setting, key or provider, and still says what works", () => {
    const words = Object.values(BANK_COPY).join(" ");
    expect(words).not.toMatch(/palvelim|tunnus|avain|paluuosoite|Enable Banking|ENABLEBANKING|APP_ID|hallinta/i);
    expect(BANK_COPY.unconfiguredBody).toMatch(/tiedostona/);
    expect(BANK_COPY.unconfiguredBody).toMatch(/käsin/);
  });
});

describe("G37: the account line under a name", () => {
  it("shows the last four digits of the IBAN, spaced or not", () => {
    expect(accountSubline("FI21 1234 5600 0007 85", null)).toBe("•••• 0785");
    expect(accountSubline("FI2112345600000785", null)).toBe("•••• 0785");
  });

  it("adds when it was updated, in the owner's date style", () => {
    const iso = new Date(2026, 8, 29, 8, 5).toISOString();
    expect(accountSubline("FI21 1234 5600 0007 85", iso, NOW)).toBe("•••• 0785 · päivitetty 8.05");
  });
});
