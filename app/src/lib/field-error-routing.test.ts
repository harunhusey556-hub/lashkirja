import { describe, expect, it } from "vitest";
import { routeFieldErrors } from "./field-error-routing";

const slots = new Set(["gross", "dueDate"]);
const hasSlot = (key: string) => slots.has(key);

describe("C-5: a refusal about a field without a slot is still shown", () => {
  it("keeps the field errors when a named field has a slot", () => {
    const fields = { gross: "Summa puuttuu.", issueDate: "Päivä ei kelpaa." };
    expect(routeFieldErrors(fields, hasSlot)).toEqual({ fields, message: "" });
  });

  it("shows the first message as the generic one when no named field has a slot", () => {
    expect(routeFieldErrors({ issueDate: "Päivä ei kelpaa.", vatDetails: "ALV ei täsmää." }, hasSlot)).toEqual({
      fields: {},
      message: "Päivä ei kelpaa.",
    });
  });

  it("does nothing for no fields", () => {
    expect(routeFieldErrors({}, hasSlot)).toEqual({ fields: {}, message: "" });
  });
});
