import { describe, expect, it } from "vitest";
import {
  APPROVE_BATCH_LIMIT,
  approvalFailureText,
  bulkApproveLabel,
  bulkImportSummary,
  bulkSavePayload,
  chunkIds,
  noticeToneFor,
  queueTotalText,
  retryableFailureIds,
  splitApprovable,
} from "./review-queue";

const eur = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;

const row = (id: string, vendor: string | null, totalAmount: number | null) => ({
  id,
  vendor,
  totalAmount,
});

describe("splitApprovable", () => {
  it("keeps receipts without an amount or a vendor out of the one-tap approval (F15)", () => {
    const { ready, incomplete } = splitApprovable([
      row("a", "Kahvila", 12.5),
      row("b", "Kahvila", null),
      row("c", null, 5),
      row("d", "Kahvila", 0),
    ]);
    expect(ready.map((r) => r.id)).toEqual(["a", "d"]);
    expect(incomplete.map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("names the gaps of each incomplete row", () => {
    const { incomplete } = splitApprovable([row("b", "Kahvila", null), row("c", "", null)]);
    expect(incomplete[0].gaps).toEqual(["amount"]);
    expect(incomplete[1].gaps).toEqual(["amount", "vendor"]);
  });
});

describe("queueTotalText", () => {
  it("sums the known totals and says how many have none", () => {
    expect(queueTotalText([row("a", "X", 10), row("b", "X", 2.5)], eur)).toBe("Yhteensä 12,50 €");
    expect(queueTotalText([row("a", "X", 10), row("b", "X", null)], eur)).toBe(
      "Yhteensä 10,00 € + 1 ilman summaa"
    );
  });

  it("shows a dash, not 0,00 €, when no receipt has a total", () => {
    expect(queueTotalText([row("a", "X", null), row("b", "X", null)], eur)).toBe("Yhteensä –");
    expect(queueTotalText([], eur)).toBe("Yhteensä –");
  });
});

describe("approvalFailureText", () => {
  it("is calm when everything went through", () => {
    expect(approvalFailureText(3, [])).toBe("Hyväksyttiin 3.");
  });

  it("names the refusal instead of a bare count", () => {
    const text = approvalFailureText(0, [
      { id: "a", error: "Kuitista puuttuu summa. Lisää summa ennen hyväksyntää." },
      { id: "b", error: "Kuitista puuttuu summa. Lisää summa ennen hyväksyntää." },
    ]);
    expect(text).toBe(
      "2 kuittia ei voitu hyväksyä: Kuitista puuttuu summa. Lisää summa ennen hyväksyntää."
    );
  });

  it("keeps what was approved and lists each distinct reason once", () => {
    expect(
      approvalFailureText(2, [
        { id: "a", error: "Kuitin kuukausi on suljettu." },
        { id: "b", error: "Kuitti on jo käsitelty." },
      ])
    ).toBe("Hyväksyttiin 2. 2 kuittia ei voitu hyväksyä: Kuitin kuukausi on suljettu. Kuitti on jo käsitelty.");
    expect(approvalFailureText(0, [{ id: "a", error: "Kuitin kuukausi on suljettu." }])).toBe(
      "Yhtä kuittia ei voitu hyväksyä: Kuitin kuukausi on suljettu."
    );
  });
});

describe("retryableFailureIds", () => {
  it("offers a retry only for failures that can change on a second try", () => {
    expect(
      retryableFailureIds([
        { id: "a", error: "Kuitista puuttuu summa. Lisää summa ennen hyväksyntää." },
        { id: "b", error: "Kuitin kuukausi on suljettu." },
        { id: "c", error: "Kuitti on jo käsitelty." },
        { id: "d", error: "Kuittia ei löytynyt" },
        { id: "e", error: "Jokin odottamaton virhe" },
      ])
    ).toEqual(["e"]);
  });
});

describe("noticeToneFor (V14, R56)", () => {
  it("is success when nothing failed, whatever the message says", () => {
    expect(noticeToneFor(0)).toBe("success");
  });

  it("is an error as soon as one item failed", () => {
    expect(noticeToneFor(1)).toBe("error");
    expect(noticeToneFor(7)).toBe("error");
  });
});

describe("chunkIds", () => {
  it("keeps every id, in order, under the endpoint's 200-id ceiling", () => {
    const ids = Array.from({ length: 450 }, (_, index) => `id-${index}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(ids);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(APPROVE_BATCH_LIMIT);
  });

  it("sends an empty list as no call at all, not one empty batch", () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe("bulkApproveLabel", () => {
  it("names the count it will act on", () => {
    expect(bulkApproveLabel(187, 0)).toBe("Hyväksy (187)");
  });

  it("says the selection is only partly ready", () => {
    expect(bulkApproveLabel(7, 3)).toBe("Hyväksy valmiit (7)");
  });
});

describe("bulkImportSummary", () => {
  it("reports both buckets, as the import promised (C)", () => {
    expect(bulkImportSummary(187, 13)).toBe("Hyväksyttiin 187 kuittia · 13 vaatii tarkistusta");
  });

  it("counts one receipt in the singular", () => {
    expect(bulkImportSummary(1, 0)).toBe("Hyväksyttiin 1 kuitti");
    expect(bulkImportSummary(0, 1)).toBe("1 vaatii tarkistusta");
  });

  it("omits a bucket that is empty, and never divides by nothing", () => {
    expect(bulkImportSummary(0, 0)).toBe("Ei hyväksyttäviä kuitteja.");
    expect(bulkImportSummary(4, 0)).toBe("Hyväksyttiin 4 kuittia");
  });
});

describe("bulkSavePayload", () => {
  it("sends the reading as the form would, with a missing amount left missing", () => {
    expect(
      bulkSavePayload("upload-1", { vendor: "Kahvila", date: "2026-09-01", totalAmount: null })
    ).toMatchObject({ uploadId: "upload-1", vendor: "Kahvila", date: "2026-09-01", totalAmount: null });
  });

  it("defaults an unread type to a purchase, never a made-up income", () => {
    expect(bulkSavePayload("u", {}).type).toBe("meno");
    expect(bulkSavePayload("u", { type: "tulo" }).type).toBe("tulo");
  });

  it("drops VAT rows that are not two numbers, so the server's own check sees clean input", () => {
    expect(
      bulkSavePayload("u", { vatDetails: [{ rate: 24, amount: 2.4 }, { rate: 14 }, {}] }).vatDetails
    ).toEqual([{ rate: 24, amount: 2.4 }]);
    expect(bulkSavePayload("u", { vatDetails: null }).vatDetails).toEqual([]);
  });
});
