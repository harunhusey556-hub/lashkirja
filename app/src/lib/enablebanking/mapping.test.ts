import { describe, expect, it } from "vitest";
import {
  bankRefFor,
  decimalToCents,
  mapBookedTransaction,
  normalizeIban,
  pickBookedBalance,
  sessionAccountsForStorage,
  toPublicConnection,
  type EbTransaction,
} from "./mapping";

const booked: EbTransaction = {
  entry_reference: "5561990681",
  transaction_id: "tx-1",
  status: "BOOK",
  credit_debit_indicator: "DBIT",
  booking_date: "2026-09-01",
  transaction_amount: { currency: "EUR", amount: "12.50" },
  creditor: { name: "Lash Studio" },
  debtor: { name: "Oma tili" },
  reference_number: "12345",
  remittance_information: ["Ripset", "syyskuu"],
};

describe("mapBookedTransaction", () => {
  it("maps a debit as a negative euro amount and a stable bank ref", () => {
    const mapped = mapBookedTransaction(booked, "fi21 1234 5600 0007 85");
    expect(mapped).toMatchObject({
      date: "2026-09-01",
      counterparty: "Lash Studio",
      amountCents: -1250,
      reference: "12345",
      message: "Ripset syyskuu",
      iban: "FI2112345600000785",
      bankRef: "eb:FI2112345600000785:5561990681",
    });
  });

  it("maps a credit as income and skips pending, foreign currency, and missing IBAN", () => {
    expect(
      mapBookedTransaction(
        { ...booked, credit_debit_indicator: "CRDT", status: "BOOK" },
        "FI2112345600000785"
      )?.amountCents
    ).toBe(1250);
    expect(mapBookedTransaction({ ...booked, status: "PDNG" }, "FI2112345600000785")).toBeNull();
    expect(
      mapBookedTransaction(
        { ...booked, transaction_amount: { currency: "SEK", amount: "10.00" } },
        "FI2112345600000785"
      )
    ).toBeNull();
    expect(mapBookedTransaction(booked, "   ")).toBeNull();
    expect(normalizeIban("not an iban")).toBeNull();
  });

  it("builds the same hash ref when the bank omits ids", () => {
    const tx: EbTransaction = {
      status: "BOOK",
      booking_date: "2026-09-02",
      credit_debit_indicator: "CRDT",
      transaction_amount: { currency: "EUR", amount: "1,50" },
      remittance_information: ["Lahja"],
    };
    const first = bankRefFor("FI2112345600000785", tx);
    const second = bankRefFor("FI2112345600000785", tx);
    expect(first).toBe(second);
    expect(first.startsWith("eb:FI2112345600000785:")).toBe(true);
    expect(mapBookedTransaction(tx, "FI2112345600000785")?.amountCents).toBe(150);
  });
});

describe("session accounts", () => {
  it("stores only IBAN accounts and leaves them out of scope", () => {
    const rows = sessionAccountsForStorage(
      [
        { uid: "a1", name: "Yritystili", currency: "EUR", account_id: { iban: "FI21 1234 5600 0007 85" } },
        { uid: "a2", name: "Ei ibania", account_id: {} },
        { uid: "a1", name: "Duplikaatti", account_id: { iban: "FI2112345600000785" } },
      ],
      "user-1",
      "conn-1"
    );
    expect(rows).toEqual([
      {
        userId: "user-1",
        connectionId: "conn-1",
        iban: "FI2112345600000785",
        label: "Yritystili",
        currency: "EUR",
        providerAccountUid: "a1",
        inScope: false,
      },
    ]);
  });

  it("does not expose the session id on the public connection", () => {
    const pub = toPublicConnection({
      id: "c1",
      aspspName: "Holvi",
      aspspCountry: "FI",
      aspspLogo: null,
      psuType: "business",
      status: "active",
      validUntil: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastError: null,
      accounts: [
        {
          id: "a1",
          iban: "FI2112345600000785",
          label: null,
          currency: "EUR",
          inScope: false,
          balanceCents: 1234,
          balanceAt: null,
        },
      ],
    });
    expect(pub.accounts[0].balance).toBe(12.34);
    expect(JSON.stringify(pub)).not.toContain("session");
  });
});

describe("balances and amounts", () => {
  it("prefers the booked balance and rounds bank decimals", () => {
    expect(decimalToCents("1.235")).toBe(124);
    expect(decimalToCents("-1.2")).toBe(-120);
    expect(decimalToCents("abc")).toBeNull();
    expect(
      pickBookedBalance([
        { balance_type: "CLAV", balance_amount: { currency: "EUR", amount: "2.00" } },
        { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "9.00" } },
        { balance_type: "CLBD", balance_amount: { currency: "SEK", amount: "9.00" } },
      ])
    ).toEqual({ amountCents: 900, currency: "EUR" });
  });
});
