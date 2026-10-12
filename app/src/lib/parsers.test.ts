import { describe, it, expect } from "vitest";
import { parseHolviTilioteLayout, parseAmountValue } from "./parsers";
import { inferTransactionType } from "./statements";

const HOLVI_SNIPPET = `
Kirjauspäivä                                  Maksutiedot                                           Tapahtuman nro                    Määrä EUR
 10.7.2026                                     Arvopäivä: 9.7.2026                                                     6               - 197,72
                                               Arkistointitunnus:
                                               3322d6bec19115b8f0b8703ac752b940
                                               FI80 8146 9710 1714 47
                                               YTH-yritystietohaku
                                               Viite: 299510
                                               Varattu: 10. heinäkuuta 2026
                                               kello 1.33
                                               Lähtevä maksu
 8.7.2026                                      Arvopäivä: 8.7.2026                                                     2                + 65,00
                                               VIPPS MOBILEPAY AS,
                                               Viesti: MobilePay Alina
                                               SEPA-maksu
`;

describe("parseAmountValue", () => {
  it("parses spaced minus before amount", () => {
    expect(parseAmountValue("- 197,72")).toBe(-197.72);
  });
});

describe("parseHolviTilioteLayout", () => {
  it("extracts outgoing Holvi payments as negative meno with real counterparty", () => {
    const txs = parseHolviTilioteLayout(HOLVI_SNIPPET);
    const yth = txs.find((tx) => tx.counterparty?.includes("YTH"));
    expect(yth).toMatchObject({
      date: "2026-07-10",
      counterparty: "YTH-yritystietohaku",
      amount: -197.72,
      reference: "299510",
    });
    expect(inferTransactionType(yth!.amount, yth!)).toBe("meno");
  });

  it("keeps incoming MobilePay credits positive", () => {
    const txs = parseHolviTilioteLayout(HOLVI_SNIPPET);
    const mobilePay = txs.find((tx) => tx.counterparty?.includes("VIPPS"));
    expect(mobilePay?.amount).toBe(65);
    expect(inferTransactionType(mobilePay!.amount, mobilePay!)).toBe("tulo");
  });

  // Owner's Holvi PDF 5.6.-9.10.2026 (Poppler 25.07, -layout): a message wraps over several lines,
  // a card payment's message is on the next lines, and a page ends with Holvi's own footer.
  // Only the first line of every message was kept (219 of 222 rows).
  const HOLVI_WRAPPED = `
 Kirjauspäivä                                  Maksutiedot                                           Tapahtuman nro                    Määrä EUR
 8.6.2026                                      Arvopäivä: 6.6.2026                                                     3                + 65,00
                                               Arkistointitunnus:
                                               76103639ffa98ad5666371eeb906126e
                                               BÖÖK JEMINA ANNA MAARIA
                                               Viesti: uudet klassiset, VH
                                               beauty, Y: 362 8546-6
                                               SEPA-maksu

 13.7.2026                                     Arvopäivä: 13.7.2026                                                   12              - 400,00
                                               Arkistointitunnus:
                                               533f46af6c04779c66fdd36e653049f1
                                               FI67 3939 0068 0305 50
                                               Vilma Hartikainen
                                               Viesti: Palkka itselleni. 400e
                                               kesä/heinäku u.
                                               Varattu: 13. heinäkuuta 2026
                                               kello 20.34
                                               Lähtevä maksu

 14.7.2026                                     Arvopäivä: 14.7.2026                                                   13               + 70,00
                                               Arkistointitunnus:
                                               9b185a5a5abe9bd74549d4934cbabf0a
                                               VIPPS MOBILEPAY AS,
                                               Viesti: MobilePay Ella Anni Ilma
                                               Lehtoranta
                                               SEPA-maksu

            LUOTTAMUKSELLINEN. Tämä viesti sisältää luottamuksellista tietoa ja on tarkoitettu vain valtuutetulle vastaanottajalle.

                               Holvi Payment Services Oy. Kaikukatu 2 C, 00530 Helsinki, Suomi. Y-tunnus 2193756-4.
                               Puh: +358 75 325 2935 Faksi: +358 92 319 4337 Sähköposti: support@holvi.com
                                                         ©2026 Holvi Payment Services Oy.                                                  2 / 33

 16.7.2026                                     Arvopäivä: 16.7.2026                                                   20              - 57,58
                                               Arkistointitunnus:
                                               b5e8a1371fc0d0b39b2faca5630cf86f
                                               LASHLOUNGE.FI
                                               Viesti: Payment sent to
                                               LASHLOUNGE.FI
                                               Varattu: 16. heinäkuuta 2026
                                               kello 22.41
                                               Korttimaksu
`;

  it("keeps a Holvi message that wraps over several lines whole, without page furniture", () => {
    const txs = parseHolviTilioteLayout(HOLVI_WRAPPED);
    expect(txs.map((tx) => [tx.counterparty, tx.message])).toEqual([
      ["BÖÖK JEMINA ANNA MAARIA", "uudet klassiset, VH beauty, Y: 362 8546-6"],
      ["Vilma Hartikainen", "Palkka itselleni. 400e kesä/heinäku u."],
      ["VIPPS MOBILEPAY AS", "MobilePay Ella Anni Ilma Lehtoranta"],
      ["LASHLOUNGE.FI", "Payment sent to LASHLOUNGE.FI"],
    ]);
    expect(txs.map((tx) => tx.amount)).toEqual([65, -400, 70, -57.58]);
  });
});

describe("Holvi PDF: a foreign payee (audit 2026-10-09)", () => {
  // From the owner's Holvi PDF (Aug-Sep 2026): 79 of 478 rows named the payee's IBAN instead of
  // the payee, and a wrapped name kept only its first line.
  const FOREIGN = `
EUR - TILIOTE
Kausi           1.8.2026 - 30.9.2026 Europe/Helsinki
 Kirjauspäivä                                  Maksutiedot                                           Tapahtuman nro                    Määrä EUR

 3.8.2026                                     Arvopäivä: 2.8.2026                                                     3               - 3 000,00
                                              Arkistointitunnus:
                                              c1991d4b9766a158a8311df6a0fb03b8
                                              PL40 2490 0005 0000 4600 0029
                                              6526
                                              KAWAFEL SPOLKA Z OGRANICZONA
                                              ODPOWIEDZIALNOSCIA
                                              Viesti: Proforma Invoice No. P
                                              18/07/2026 VAT ID 8393214617
                                              Varattu: 3. elokuuta 2026 kello
                                              Lähtevä maksu

 4.8.2026                                     Arvopäivä: 4.8.2026                                                     4               - 12,00
                                              Arkistointitunnus:
                                              b5e8a1371fc0d0b39b2faca5630cf86e
                                              LV80 BANK 0000 4351 9500 1
                                              SIA PIRKUMS
                                              Lähtevä maksu
`;

  it("names the payee, not its IBAN, and keeps a wrapped name whole", () => {
    const txs = parseHolviTilioteLayout(FOREIGN);
    expect(txs.map((tx) => [tx.counterparty, tx.amount])).toEqual([
      ["KAWAFEL SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA", -3000],
      ["SIA PIRKUMS", -12],
    ]);
    expect(txs[0].message).toBe("Proforma Invoice No. P 18/07/2026 VAT ID 8393214617");
  });
});

describe("V30: a file the parser cannot read is refused in plain Finnish", () => {
  async function failure(name: string, bytes: Buffer, parse: (file: string) => Promise<unknown>) {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-parse-"));
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    try {
      await parse(file);
      return null;
    } catch (error) {
      return error as { message: string; code?: string };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const raw = /Unclosed|Line:|Column:|unzip|ENOENT|spawn|Couldn't|undefined|Error/;

  it("a truncated camt XML names no library text", async () => {
    const { parseCamtXML } = await import("./parsers");
    const error = await failure("a.xml", Buffer.from('<?xml version="1.0"?><Document><BkToCstmrAcctRpt>'), parseCamtXML);
    expect(error?.code).toBe("INVALID_XML");
    expect(error?.message).not.toMatch(raw);
    expect(error?.message).toMatch(/XML/);
  });

  it("a junk xlsx that starts with PK names no library text", async () => {
    const { parseXLSX } = await import("./parsers");
    const error = await failure("a.xlsx", Buffer.concat([Buffer.from("PK"), Buffer.from("not really a zip file")]), parseXLSX);
    expect(error?.code).toBe("INVALID_XLSX");
    expect(error?.message).not.toMatch(raw);
  });
});
