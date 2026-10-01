import { describe, expect, it } from "vitest";
import { validateProfileNames } from "./profile-names";

describe("validateProfileNames (F63)", () => {
  it("accepts ordinary names, with or without surrounding spaces", () => {
    expect(validateProfileNames("Anna", "Virtanen")).toEqual({});
    expect(validateProfileNames("  Anna ", " Virtanen  ")).toEqual({});
  });

  it("asks for a first and a last name when blank or only spaces", () => {
    expect(validateProfileNames("   ", "Virtanen")).toEqual({ firstName: "Anna etunimi." });
    expect(validateProfileNames("Anna", "")).toEqual({ lastName: "Anna sukunimi." });
  });

  it("refuses a name over 120 characters, counted after trimming", () => {
    expect(validateProfileNames("a".repeat(120), "b")).toEqual({});
    expect(validateProfileNames(` ${"a".repeat(120)} `, "b")).toEqual({});
    expect(validateProfileNames("a".repeat(121), "b").firstName).toContain("120");
    expect(validateProfileNames("a", "b".repeat(121)).lastName).toContain("120");
  });
});
