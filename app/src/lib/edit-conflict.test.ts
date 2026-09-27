import { describe, expect, it } from "vitest";
import { ConflictError } from "./api-errors";
import { assertCurrentVersion } from "./edit-conflict";

describe("concurrent edit", () => {
  const current = new Date("2026-09-27T12:00:00.000Z");

  it("allows a save that still has the version it edited", () => {
    expect(() => assertCurrentVersion(current, current.toISOString())).not.toThrow();
  });

  it("allows a save that does not name a version", () => {
    expect(() => assertCurrentVersion(current, undefined)).not.toThrow();
    expect(() => assertCurrentVersion(current, null)).not.toThrow();
  });

  it("refuses a stale version before anything is written", () => {
    expect(() => assertCurrentVersion(current, "2026-09-27T11:00:00.000Z")).toThrow(ConflictError);
    try {
      assertCurrentVersion(current, "2026-09-27T11:00:00.000Z");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).statusCode).toBe(409);
      expect((error as ConflictError).message).toContain("Lataa tiedot uudelleen");
    }
  });
});
