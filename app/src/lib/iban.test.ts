import { describe, it, expect } from "vitest";
import {
  bankNameFromIban,
  extractIbans,
  extractOwnIban,
  formatIban,
  isValidIban,
  maskIban,
  normalizeIban,
} from "./iban";

describe("normalizeIban", () => {
  it("strips spaces, dashes and non-breaking spaces and uppercases", () => {
    expect(normalizeIban("fi21 1234 5600 0007 85")).toBe("FI2112345600000785");
    expect(normalizeIban("FI21-1234-5600-0007-85")).toBe("FI2112345600000785");
    expect(normalizeIban("FI21 1234 5600 0007 85")).toBe(
      "FI2112345600000785"
    );
  });

  it("is idempotent", () => {
    const once = normalizeIban("fi21 1234 5600 0007 85");
    expect(normalizeIban(once)).toBe(once);
  });
});

describe("isValidIban", () => {
  it("accepts real IBANs from several countries", () => {
    for (const iban of [
      "FI2112345600000785",
      "FI7054000420152230",
      "FI4747150010416111",
      "DE89370400440532013000",
      "GB82WEST12345698765432",
      "SE4550000000058398257466",
      "NO9386011117947",
    ]) {
      expect(isValidIban(iban), iban).toBe(true);
    }
  });

  it("accepts the printed spaced form and lowercase input", () => {
    expect(isValidIban("FI21 1234 5600 0007 85")).toBe(true);
    expect(isValidIban("fi21 1234 5600 0007 85")).toBe(true);
  });

  it("rejects a single-digit typo that keeps the length", () => {
    expect(isValidIban("FI2112345600000786")).toBe(false);
    expect(isValidIban("FI2212345600000785")).toBe(false);
  });

  it("rejects two transposed digits", () => {
    // 0785 -> 0875 keeps every digit, only the order changes.
    expect(isValidIban("FI2112345600000875")).toBe(false);
  });

  it("rejects wrong length for a known country", () => {
    expect(isValidIban("FI211234560000078")).toBe(false);
    expect(isValidIban("FI21123456000007855")).toBe(false);
  });

  it("rejects structurally impossible values", () => {
    for (const bad of [
      "",
      "   ",
      "FI",
      "2112345600000785",
      "FIXX12345600000785",
      "F12112345600000785",
      "FI21 1234 5600 0007 8!",
    ]) {
      expect(isValidIban(bad), bad).toBe(false);
    }
  });

  it("rejects null and undefined without throwing", () => {
    expect(isValidIban(null)).toBe(false);
    expect(isValidIban(undefined)).toBe(false);
  });

  it("stays correct for the longest allowed IBANs (no float precision loss)", () => {
    // 28 characters; a naive parseInt of the expanded form overflows here.
    expect(isValidIban("PL61109010140000071219812874")).toBe(true);
    expect(isValidIban("PL61109010140000071219812875")).toBe(false);
  });
});

describe("formatIban / maskIban", () => {
  it("formats in groups of four with no trailing space", () => {
    expect(formatIban("FI2112345600000785")).toBe("FI21 1234 5600 0007 85");
    expect(formatIban("FI2112345600000785")).not.toMatch(/\s$/);
  });

  it("formats an exact multiple of four without a trailing space", () => {
    expect(formatIban("NO9386011117947")).toBe("NO93 8601 1117 947");
    expect(formatIban("DE89370400440532013000")).toBe("DE89 3704 0044 0532 0130 00");
  });

  it("masks everything except country and last four", () => {
    expect(maskIban("FI2112345600000785")).toBe("FI•••• 0785");
  });

  it("leaves very short values untouched instead of producing nonsense", () => {
    expect(maskIban("FI2112")).toBe("FI2112");
  });
});

describe("bankNameFromIban", () => {
  it("maps Finnish bank code prefixes", () => {
    expect(bankNameFromIban("FI2112345600000785")).toBe("Nordea");
    expect(bankNameFromIban("FI7054000420152230")).toBe("OP");
    expect(bankNameFromIban("FI4747150010416111")).toBe("Säästöpankki / POP / Aktia");
    expect(bankNameFromIban("FI1666011000000123")).toBe("Ålandsbanken");
  });

  it("returns null for non-Finnish and invalid IBANs instead of guessing", () => {
    expect(bankNameFromIban("DE89370400440532013000")).toBeNull();
    expect(bankNameFromIban("FI2112345600000786")).toBeNull();
    expect(bankNameFromIban(null)).toBeNull();
  });
});

describe("extractIbans", () => {
  it("finds IBANs in camt.053-style XML and ranks by frequency", () => {
    const xml = `
      <Stmt><Acct><Id><IBAN>FI2112345600000785</IBAN></Id></Acct>
      <Ntry><RltdPties><CdtrAcct><Id><IBAN>FI7054000420152230</IBAN></Id></CdtrAcct></RltdPties></Ntry>
      <Ntry><DbtrAcct><IBAN>FI2112345600000785</IBAN></DbtrAcct></Ntry></Stmt>`;
    expect(extractIbans(xml)).toEqual(["FI2112345600000785", "FI7054000420152230"]);
  });

  it("reads spaced and lowercase IBANs out of CSV text", () => {
    const csv = "Tili;fi21 1234 5600 0007 85\n05.01.2026;Maksu;-12,00\n";
    expect(extractIbans(csv)).toEqual(["FI2112345600000785"]);
  });

  it("ignores strings that merely look like IBANs", () => {
    const noise = "REF 1234567890123456 VIITE FI2112345600000786 ORDER AB12CD34EF56";
    expect(extractIbans(noise)).toEqual([]);
  });

  it("returns an empty list for empty input", () => {
    expect(extractIbans("")).toEqual([]);
  });
});

describe("F52: extractOwnIban names the file's own account, never a counterparty's", () => {
  const A = "FI2112345600000785";
  const B = "FI4950009420028730";

  it("takes a labelled line, whatever the counterparty columns hold", () => {
    const csv = `Tilinumero;${B}
Päivä;Summa;Saaja;Saajan tilinumero
05.01.2026;-5,00;Oma siirto;${A}
`;
    expect(extractOwnIban(csv)).toBe(B);
    expect(extractOwnIban(`IBAN: ${B.slice(0, 4)} ${B.slice(4, 8)} ${B.slice(8)}
x;y
`)).toBe(B);
  });

  it("takes the camt statement's own account, not an entry's", () => {
    const xml = `<Stmt><Acct><Id><IBAN>${B}</IBAN></Id></Acct><Ntry><RltdPties><CdtrAcct><Id><IBAN>${A}</IBAN></Id></CdtrAcct></RltdPties></Ntry><Ntry><CdtrAcct><Id><IBAN>${A}</IBAN></Id></CdtrAcct></Ntry></Stmt>`;
    expect(extractOwnIban(xml)).toBe(B);
  });

  it("falls back to the one IBAN mentioned most, and to nothing on a tie", () => {
    expect(extractOwnIban(`a;${A}
b;${A}
c;${B}
`)).toBe(A);
    expect(extractOwnIban(`Saaja;${A}
Saaja;${B}
`)).toBeNull();
    expect(extractOwnIban("ei tilinumeroa täällä")).toBeNull();
  });
});
