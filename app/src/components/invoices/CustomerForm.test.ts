import { describe, expect, it } from "vitest";
import { validateCustomerForm, type CustomerFormValues } from "./CustomerForm";

function values(patch: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    name: "Kauneus Oy",
    businessId: "",
    contactPerson: "",
    email: "",
    phone: "",
    addressStreet: "",
    addressPostalCode: "",
    addressCity: "",
    defaultPaymentTermDays: "14",
    notes: "",
    ...patch,
  };
}

function term(result: ReturnType<typeof validateCustomerForm>) {
  return result.ok ? result.payload.defaultPaymentTermDays : result.errors.defaultPaymentTermDays;
}

describe("the payment term field of the customer form (F65)", () => {
  it("keeps the default instead of saving 0 days when the field is emptied", () => {
    expect(term(validateCustomerForm(values({ defaultPaymentTermDays: "" })))).toBe(14);
    expect(term(validateCustomerForm(values({ defaultPaymentTermDays: "   " })))).toBe(14);
  });

  it("keeps the term the customer already had when an edit empties the field", () => {
    expect(term(validateCustomerForm(values({ defaultPaymentTermDays: "" }), 21))).toBe(21);
  });

  it("refuses anything that is not a whole number of days, with the inline message", () => {
    for (const typed of ["abc", "1e2", "0x10", "14.5", "-1", "400", "+5", "1 4"]) {
      expect(term(validateCustomerForm(values({ defaultPaymentTermDays: typed })))).toBe(
        "Maksuaika on 0-365 päivää."
      );
    }
  });

  it("accepts 0 when it is typed, and the ends of the range", () => {
    expect(term(validateCustomerForm(values({ defaultPaymentTermDays: "0" })))).toBe(0);
    expect(term(validateCustomerForm(values({ defaultPaymentTermDays: " 365 " })))).toBe(365);
    expect(term(validateCustomerForm(values({ defaultPaymentTermDays: "30" })))).toBe(30);
  });
});
