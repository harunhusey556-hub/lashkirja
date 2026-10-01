import { describe, expect, it } from "vitest";
import { CLOSE_PURGE_COPY } from "./account-copy";

describe("close copy about the bank consent (F57)", () => {
  it("says the consent is ended at the bank and what happens when the bank does not answer", () => {
    expect(CLOSE_PURGE_COPY).toMatch(/katkaistaan pankissa/);
    expect(CLOSE_PURGE_COPY).toMatch(/pankkisi sovelluksessa/);
    expect(CLOSE_PURGE_COPY).toMatch(/itsestään/);
    expect(CLOSE_PURGE_COPY).not.toContain("—");
  });
});
