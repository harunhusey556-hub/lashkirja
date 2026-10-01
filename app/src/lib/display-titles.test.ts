import { describe, expect, it } from "vitest";
import { jobTitle, looksLikeFileName, receiptTitle, shortDay, statementTitle } from "./display-titles";

describe("F28: a file name is never a title", () => {
  it("recognises file and camera names", () => {
    for (const name of ["e2e-queue-1.jpg", "tiliote-demo.csv", "kuitti-1759251867123.jpg", "LT-ver-F03.PDF", "IMG_20260928.heic"]) {
      expect(looksLikeFileName(name), name).toBe(true);
    }
    for (const name of ["Posti Oy", "Kuitti 28.9.", "K-Market Lauttasaari", ""]) {
      expect(looksLikeFileName(name), name).toBe(false);
    }
  });

  it("a receipt is its vendor, else Kuitti with the day", () => {
    expect(receiptTitle({ vendor: "Posti Oy", date: "2026-09-28T00:00:00.000Z" })).toBe("Posti Oy");
    expect(receiptTitle({ vendor: null, date: "2026-09-28T00:00:00.000Z" })).toBe("Kuitti 28.9.");
    expect(receiptTitle({ vendor: "", date: null, createdAt: "2026-09-27T21:30:00.000Z" })).toBe("Kuitti 28.9.");
    expect(receiptTitle({ vendor: "e2e-queue-1.jpg", date: "2026-09-05T00:00:00.000Z" })).toBe("Kuitti 5.9.");
    expect(receiptTitle({})).toBe("Kuitti");
  });

  it("a stored analysis job title with a file name reads Kuitti and the day", () => {
    const title = jobTitle({
      kind: "document_analysis",
      title: "Kuitin analysointi: e2e-queue-1.jpg",
      createdAt: "2026-09-28T09:00:00.000Z",
    });
    expect(title).toBe("Kuitti 28.9.");
    expect(title).not.toMatch(/\.jpg/);
    expect(jobTitle({ kind: "bank_sync", title: "x.csv" })).toBe("Pankkitapahtumien haku");
    expect(jobTitle({ kind: "other", title: "tiedosto.pdf" })).toBe("Työ");
  });

  it("a tiliote is named by its month", () => {
    expect(statementTitle({ fileType: "csv", periodMonth: "2026-08" })).toBe("Tiliote · elokuu 2026");
    expect(statementTitle({ fileType: "enablebanking", periodMonth: "2026-08" })).toBe("Pankkiyhteys · elokuu 2026");
    expect(shortDay("not a date")).toBeNull();
  });
});
