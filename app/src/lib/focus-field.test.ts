import { describe, expect, it } from "vitest";
import { firstInvalidKey, invalidFieldProps } from "./focus-field";

describe("first invalid field", () => {
  it("picks the earliest field in screen order", () => {
    expect(
      firstInvalidKey(
        { dueDate: "myöhässä", customerId: "puuttuu", "line-0-unitPrice": "hinta" },
        ["customerId", "issueDate", "dueDate", "line-0-unitPrice"]
      )
    ).toBe("customerId");
  });

  it("falls back to the first reported key when the order list misses it", () => {
    expect(firstInvalidKey({ notes: "liian pitkä" })).toBe("notes");
    expect(firstInvalidKey({})).toBeNull();
  });
});

describe("field error names", () => {
  it("marks an invalid control and points at its message", () => {
    expect(invalidFieldProps("ba-iban", "IBAN ei ole kelvollinen.")).toEqual({
      id: "ba-iban",
      "aria-invalid": true,
      "aria-describedby": "ba-iban-error",
    });
  });

  it("points at the hint when there is no error", () => {
    expect(invalidFieldProps("email", undefined, "email-hint")).toEqual({
      id: "email",
      "aria-invalid": undefined,
      "aria-describedby": "email-hint",
    });
  });

  it("adds neither invalid nor describedby on a clean field without a hint", () => {
    expect(invalidFieldProps("email")).toEqual({
      id: "email",
      "aria-invalid": undefined,
      "aria-describedby": undefined,
    });
  });
});
