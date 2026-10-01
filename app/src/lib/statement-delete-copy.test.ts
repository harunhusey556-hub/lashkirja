import { describe, expect, it } from "vitest";
import { deleteRowDescription, deleteStatementDescription } from "./statement-delete-copy";

const plain = { settlesInvoice: false, pendingSale: false };

describe("V19 V24: the delete dialogs only talk about what is really involved", () => {
  it("a plain row mentions neither an invoice nor a sale", () => {
    const text = deleteRowDescription(plain);
    expect(text).toBe("Tapahtuma poistetaan pysyvästi.");
    expect(text).not.toMatch(/lasku|myynti/i);
  });

  it("a row with a waiting sale says the proposal goes too, and nothing about an invoice", () => {
    const text = deleteRowDescription({ settlesInvoice: false, pendingSale: true });
    expect(text).toContain("myyntiehdotus poistuu myös");
    expect(text).not.toMatch(/Lasku/);
  });

  it("a row that paid an invoice says the invoice stays paid and an approved sale is rejected", () => {
    const text = deleteRowDescription({ settlesInvoice: true, pendingSale: false });
    expect(text).toContain("Lasku jää maksetuksi");
    expect(text).toContain("hylätyksi");
  });

  it("a statement dialog counts what is inside", () => {
    expect(deleteStatementDescription("tili.csv", [plain, plain])).toBe(
      '"tili.csv" ja kaikki sen tapahtumat poistetaan pysyvästi. Tätä ei voi perua.'
    );
    const rich = deleteStatementDescription("tili.csv", [
      { settlesInvoice: true, pendingSale: true },
      plain,
    ]);
    expect(rich).toContain("myyntiehdotukset poistuvat myös");
    expect(rich).toContain("Lasku jää maksetuksi");
    expect(rich.endsWith("Tätä ei voi perua.")).toBe(true);
  });
});
