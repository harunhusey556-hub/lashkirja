import { describe, expect, it } from "vitest";
import { consentReconnectCopy } from "./bank-consent-copy";

const base = {
  status: "active",
  lastError: null,
  lastSuccessAt: "2026-03-01T10:00:00.000Z",
  lastSyncAt: "2026-03-02T10:00:00.000Z",
  validUntil: "2026-06-01T00:00:00.000Z",
  accounts: [
    { iban: "FI2112345600000785", label: "Käyttötili", inScope: true },
    { iban: "FI2112345600000786", label: "Muu", inScope: false },
  ],
};

describe("consentReconnectCopy", () => {
  it("stays quiet while the consent is usable", () => {
    expect(consentReconnectCopy(base, new Date("2026-04-01T00:00:00.000Z"))).toBeNull();
  });

  it("names the reason, the in-scope accounts, and the last success", () => {
    const copy = consentReconnectCopy(
      {
        ...base,
        status: "expired",
        lastError: "Yhteys vanhentui — yhdistä uudelleen.",
        lastSuccessAt: "2026-01-15T08:00:00.000Z",
        lastSyncAt: "2026-04-01T08:00:00.000Z",
      },
      new Date("2026-04-02T00:00:00.000Z")
    );
    expect(copy?.reason).toBe("Yhteys vanhentui — yhdistä uudelleen.");
    expect(copy?.accounts).toEqual(["Käyttötili · FI2112345600000785"]);
    expect(copy?.lastSuccessAt).toBe("2026-01-15T08:00:00.000Z");
    expect(copy?.lastAttemptAt).toBe("2026-04-01T08:00:00.000Z");
  });

  it("does not treat a failed attempt as a successful sync", () => {
    const copy = consentReconnectCopy(
      { ...base, status: "error", lastSuccessAt: null, lastError: null },
      new Date("2026-04-01T00:00:00.000Z")
    );
    expect(copy?.lastSuccessAt).toBeNull();
    expect(copy?.reason).toBe("Yhteys epäonnistui.");
  });

  it("warns when validUntil has passed even if status is still active", () => {
    const copy = consentReconnectCopy(base, new Date("2026-07-01T00:00:00.000Z"));
    expect(copy?.reason).toBe("Suostumus on vanhentunut.");
  });
});
