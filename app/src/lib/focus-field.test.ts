import { describe, expect, it } from "vitest";
import { firstInvalidKey } from "./focus-field";

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
