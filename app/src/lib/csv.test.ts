import { describe, expect, it } from "vitest";
import {
  csvAttachmentHeaders,
  csvMoney,
  escapeCsvField,
  toCsv,
  UTF8_BOM,
} from "./csv";

describe("escapeCsvField", () => {
  it("passes plain text through", () => {
    expect(escapeCsvField("Anna Asiakas")).toBe("Anna Asiakas");
    expect(escapeCsvField(42)).toBe("42");
  });

  it("returns an empty cell for null and undefined", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });

  it("quotes separators, quotes and newlines so columns cannot shift", () => {
    expect(escapeCsvField("Yritys; Oy")).toBe('"Yritys; Oy"');
    expect(escapeCsvField('Sanoi "hei"')).toBe('"Sanoi ""hei"""');
    expect(escapeCsvField("rivi1\nrivi2")).toBe('"rivi1\nrivi2"');
    expect(escapeCsvField("rivi1\r\nrivi2")).toBe('"rivi1\r\nrivi2"');
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(escapeCsvField("=1+1")).toBe("'=1+1");
    expect(escapeCsvField("+41")).toBe("'+41");
    expect(escapeCsvField("-41")).toBe("'-41");
    expect(escapeCsvField("@SUM(A1)")).toBe("'@SUM(A1)");
    // A negative number is data, not a formula, once it goes through csvMoney.
    expect(escapeCsvField(csvMoney(-41))).toBe("'-41,00");
  });
});

describe("csvMoney", () => {
  it("always writes two decimals with a comma", () => {
    expect(csvMoney(1234.5)).toBe("1234,50");
    expect(csvMoney(0)).toBe("0,00");
    expect(csvMoney(-12.345)).toBe("-12,35");
  });

  it("returns an empty cell for missing values", () => {
    expect(csvMoney(null)).toBe("");
    expect(csvMoney(undefined)).toBe("");
    expect(csvMoney(Number.NaN)).toBe("");
  });
});

describe("toCsv", () => {
  it("writes a BOM, semicolons and CRLF line endings", () => {
    const csv = toCsv(["Päivä", "Summa"], [["2026-01-05", csvMoney(12.5)]]);
    expect(UTF8_BOM.charCodeAt(0)).toBe(0xfeff); // the constant itself, not just self-consistency
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(`${UTF8_BOM}Päivä;Summa\r\n2026-01-05;12,50\r\n`);
  });

  it("emits only the header row when there is no data", () => {
    expect(toCsv(["A", "B"], [])).toBe(`${UTF8_BOM}A;B\r\n`);
  });

  it("keeps a quoted newline inside its own cell", () => {
    const csv = toCsv(["Nimi"], [["rivi1\nrivi2"]]);
    // Three physical lines, but only two logical records.
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("csvAttachmentHeaders", () => {
  it("sanitises the filename and sets no-store", () => {
    const headers = csvAttachmentHeaders("kuitit 2026-01.csv");
    expect(headers["Content-Disposition"]).toBe('attachment; filename="kuitit_2026-01.csv"');
    expect(headers["Content-Type"]).toContain("charset=utf-8");
    expect(headers["Cache-Control"]).toContain("no-store");
  });

  it("strips characters that could break the header", () => {
    const headers = csvAttachmentHeaders('evil"; rm -rf /.csv');
    expect(headers["Content-Disposition"]).not.toContain('"; rm');
  });
});
