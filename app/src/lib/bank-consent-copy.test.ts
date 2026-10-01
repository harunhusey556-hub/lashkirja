import { describe, expect, it } from "vitest";
import { calmBankError, consentReconnectCopy, consentWithdrawn } from "./bank-consent-copy";

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

describe("G33: a stored operator text is never shown", () => {
  it("replaces text that names settings or is the provider's English", () => {
    for (const stored of [
      "Ohjausosoite ei ole sallittu Enable Bankingissa. Tarkista ENABLEBANKING_REDIRECT_URL Control Panelissa.",
      "Pankkiyhteyden tunnistautuminen epäonnistui. Tarkista sovelluksen avain ja APP_ID.",
      "Forbidden",
    ]) {
      expect(calmBankError(stored)).toBe("Pankkiyhteys epäonnistui. Yritä uudelleen.");
    }
    expect(calmBankError("Pankki ei sallinut yhteyttä.")).toBe("Pankki ei sallinut yhteyttä.");
    expect(calmBankError("  ")).toBeNull();
  });

  it("uses the calm text as the reconnect reason", () => {
    const copy = consentReconnectCopy({ ...base, status: "error", lastError: "Tarkista sovelluksen avain ja APP_ID." });
    expect(copy?.reason).toBe("Pankkiyhteys epäonnistui. Yritä uudelleen.");
  });
});

describe("G31: a consent the bank withdrew", () => {
  it("is a reconnect case with its own reason", () => {
    const connection = { ...base, status: "expired", lastError: "Pankki on peruuttanut luvan." };
    expect(consentWithdrawn(connection)).toBe(true);
    expect(consentReconnectCopy(connection, new Date("2026-04-01T00:00:00.000Z"))?.reason).toBe("Pankki on peruuttanut luvan.");
    expect(consentWithdrawn({ lastError: "Yhteys vanhentui — yhdistä uudelleen." })).toBe(false);
  });
});
