import { describe, expect, it } from "vitest";
import { buildStoredZip, readStoredZip } from "./zip-store";

describe("stored zip", () => {
  it("round-trips utf-8 names and bytes", () => {
    const zip = buildStoredZip([
      { name: "lue-minut.txt", data: Buffer.from("Hei", "utf8") },
      { name: "tositteet/kuitti.pdf", data: Buffer.from("%PDF-1.1") },
    ]);
    const files = readStoredZip(zip);
    expect(files.get("lue-minut.txt")?.toString("utf8")).toBe("Hei");
    expect(files.get("tositteet/kuitti.pdf")?.toString("utf8")).toBe("%PDF-1.1");
  });

  it("rejects a path that leaves the archive", () => {
    expect(() => buildStoredZip([{ name: "../secret", data: Buffer.from("x") }])).toThrow(
      /Unsafe zip entry/
    );
  });
});
