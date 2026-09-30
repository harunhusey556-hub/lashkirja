import { describe, expect, it } from "vitest";
import {
  bankRefFor,
  contentFingerprint,
  decimalToCents,
  mapBookedTransaction,
  normalizeIban,
  pickBookedBalance,
  sessionAccountsForStorage,
  toPublicConnection,
  withOccurrenceRefs,
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

describe("fallback identity without a bank reference (G26, G29)", () => {
  const IBAN = "FI2112345600000785";
  const bare: EbTransaction = {
    status: "BOOK",
    booking_date: "2026-09-29",
    transaction_date: "2026-09-28",
    credit_debit_indicator: "DBIT",
    transaction_amount: { currency: "EUR", amount: "7.5" },
    reference_number: "RF1",
    remittance_information: ["Kahvi  ostos"],
    creditor: { name: "R-kioski" },
  };
  const ref = (tx: EbTransaction) => mapBookedTransaction(tx, IBAN)!.bankRef;

  it("is the same for '7.5' and '7.50', for a comma amount and for padded whitespace", () => {
    const base = ref(bare);
    expect(ref({ ...bare, transaction_amount: { currency: "EUR", amount: "7.50" } })).toBe(base);
    expect(ref({ ...bare, transaction_amount: { currency: "EUR", amount: "7,5" } })).toBe(base);
    expect(ref({ ...bare, remittance_information: ["Kahvi ostos "] })).toBe(base);
    expect(ref({ ...bare, remittance_information: ["  Kahvi", "ostos"] })).toBe(base);
  });

  it("ignores letter case in names and text, and a late or changed transaction_date", () => {
    const base = ref(bare);
    expect(ref({ ...bare, creditor: { name: " R-KIOSKI " }, remittance_information: ["KAHVI OSTOS"] })).toBe(base);
    expect(ref({ ...bare, transaction_date: undefined })).toBe(base);
    expect(ref({ ...bare, transaction_date: "2026-09-29" })).toBe(base);
    expect(ref({ ...bare, booking_date: "2026-09-29T00:00:00Z" })).toBe(base);
  });

  it("differs when the money, the day or the counterparty really differ", () => {
    const base = ref(bare);
    expect(ref({ ...bare, transaction_amount: { currency: "EUR", amount: "7.51" } })).not.toBe(base);
    expect(ref({ ...bare, booking_date: "2026-09-30" })).not.toBe(base);
    expect(ref({ ...bare, creditor: { name: "Toinen kioski" } })).not.toBe(base);
    expect(ref({ ...bare, credit_debit_indicator: "CRDT" })).not.toBe(base);
  });

  it("keeps the old raw-string digest as legacyBankRef so stored rows are still recognised", () => {
    const mapped = mapBookedTransaction(bare, IBAN)!;
    expect(mapped.stableRef).toBe(false);
    expect(mapped.legacyBankRef).toBe(`eb:${IBAN}:c6105c483cacfc96d57d2b474204b5a2`);
    const withRef = mapBookedTransaction({ ...bare, entry_reference: "E1" }, IBAN)!;
    expect(withRef.stableRef).toBe(true);
    expect(withRef.bankRef).toBe(`eb:${IBAN}:E1`);
    expect(withRef.legacyBankRef).toBeNull();
  });

  it("gives genuine identical twins their own refs and leaves the first one stable", () => {
    const [first, second, third] = withOccurrenceRefs([
      mapBookedTransaction(bare, IBAN)!,
      mapBookedTransaction({ ...bare, transaction_amount: { currency: "EUR", amount: "7.50" } }, IBAN)!,
      mapBookedTransaction(bare, IBAN)!,
    ]);
    expect(first.bankRef).toBe(ref(bare));
    expect(first.occurrence).toBe(1);
    expect(second.bankRef).toBe(`${ref(bare)}~2`);
    expect(third.bankRef).toBe(`${ref(bare)}~3`);
    expect(second.legacyBankRef).toBeNull();
    expect(new Set([first, second, third].map((row) => row.bankRef)).size).toBe(3);
  });

  it("does not touch rows that carry a bank reference, even when they look alike", () => {
    const rows = withOccurrenceRefs([
      mapBookedTransaction({ ...bare, entry_reference: "A" }, IBAN)!,
      mapBookedTransaction({ ...bare, entry_reference: "A" }, IBAN)!,
      mapBookedTransaction({ ...bare, entry_reference: "B" }, IBAN)!,
    ]);
    expect(rows.map((row) => row.bankRef)).toEqual([`eb:${IBAN}:A`, `eb:${IBAN}:A`, `eb:${IBAN}:B`]);
  });

  it("fingerprints a stored row the same way as a fetched one", () => {
    const mapped = mapBookedTransaction(bare, IBAN)!;
    expect(
      contentFingerprint({
        iban: IBAN,
        date: mapped.date,
        amountCents: mapped.amountCents,
        reference: mapped.reference,
        message: "KAHVI OSTOS ",
        counterparty: "r-kioski",
      })
    ).toBe(mapped.fingerprint);
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
