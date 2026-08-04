import { describe, it, expect } from "vitest";
import { parseOCRText, extractReferenceFields } from "./ai";

const PINK_BEAUTY_SNIPPET = `
PinkBeauty
Kuitti tilaukselle 14837
Päivämäärä                 20.7.2026
Tilausnumero               14837
Maksun viite               2 02607 20002 02863
Maksutapa                  Kustom Checkout / 28,27 €
Tuotteet yhteensä         24,80 €
Yhteensä       28,27 €
20.7.2026       Kustom Checkout   2026072000202863            Maksettu           28,27€
VEROKANTA     VEROTON        VERON MÄÄRÄ        VEROLLINEN
25.5%             22,52 €            5,75 €          28,27 €
Yhteensä          22,52 €            5,75 €          28,27 €
`;

const YTH_PAYMENT_SNIPPET = `
Maksukuitti                                                2.8.2026
Vastaanottaja           YTH-yritystietohaku
Summa                   197,72 EUR
Viitenumero             299510
Maksumääräyksen päivä   10.7.2026
Maksun kirjauspäivä     10.7.2026
`;

const VARMA_OCR_SNIPPET = `
PL 2, 00098 VARMA FINLAND
Laskun päivä 01.07.2026
Eräpäivä 20.07.2026
YEL-vakuutus 55-2880737F
Keskinäinen työeläkevakuutusyhtiö Varma PL 2, 00098 VARMA
Maksettaessa on käytettävä laskun viitenumeroa.
JN 23055 28807 37031
Frän konto nr 20.07.2026 Euro 149,50
Puhelin +358 10 192 100
`;

describe("parseOCRText", () => {
  it("uses final total and tilausnumero on e-commerce receipts", () => {
    const r = parseOCRText(PINK_BEAUTY_SNIPPET);
    expect(r.vendor).toBe("PinkBeauty");
    expect(r.date).toBe("2026-07-20");
    expect(r.totalAmount).toBe(28.27);
    expect(r.vatDetails).toEqual([{ rate: 25.5, amount: 5.75 }]);
    expect(r.reference).toBe("2 02607 20002 02863");
    expect(r.invoiceNumber).toBe("14837");
  });

  it("reads bank payment slips via vastaanottaja and payment date", () => {
    const r = parseOCRText(YTH_PAYMENT_SNIPPET);
    expect(r.vendor).toBe("YTH-yritystietohaku");
    expect(r.date).toBe("2026-07-10");
    expect(r.totalAmount).toBe(197.72);
    expect(r.reference).toBe("299510");
  });

  it("handles OCR payment slips for Varma YEL invoices", () => {
    const r = parseOCRText(VARMA_OCR_SNIPPET);
    expect(r.vendor).toBe("Varma");
    expect(r.date).toBe("2026-07-01");
    expect(r.totalAmount).toBe(149.5);
    expect(r.reference).toBe("23055 28807 37031");
    expect(r.category).toBe("työeläke");
  });
});

describe("extractReferenceFields", () => {
  it("finds Finnish payment slip references after JN", () => {
    expect(extractReferenceFields(VARMA_OCR_SNIPPET).reference).toBe(
      "23055 28807 37031"
    );
  });
});
