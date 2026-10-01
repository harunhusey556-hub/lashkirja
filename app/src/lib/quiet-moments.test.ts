import { describe, expect, it } from "vitest";
import { firstInvoiceSentMoment, firstVatFiledMoment } from "./quiet-moments";

const none = { draft: 0, sent: 0, overdue: 0, paid: 0, credited: 0 };

describe("quiet moments", () => {
  it("the first invoice that left is named once", () => {
    expect(firstInvoiceSentMoment({ ...none, sent: 1 })).toBe("Ensimmäinen lasku lähti.");
    expect(firstInvoiceSentMoment({ ...none, draft: 3, sent: 1 })).toBe("Ensimmäinen lasku lähti.");
    expect(firstInvoiceSentMoment({ ...none, overdue: 1 })).toBe("Ensimmäinen lasku lähti.");
  });
  it("is silent when an earlier invoice already went out", () => {
    expect(firstInvoiceSentMoment({ ...none, sent: 2 })).toBeNull();
    expect(firstInvoiceSentMoment({ ...none, sent: 1, paid: 1 })).toBeNull();
    expect(firstInvoiceSentMoment({ ...none, paid: 1 })).toBeNull();
    expect(firstInvoiceSentMoment({ ...none, draft: 2 })).toBeNull();
    expect(firstInvoiceSentMoment(null)).toBeNull();
  });
  it("names the first ALV return only when the server says it was the first", () => {
    expect(firstVatFiledMoment(true)).toBe("ALV-ilmoitus on merkitty tehdyksi.");
    expect(firstVatFiledMoment(false)).toBeNull();
    expect(firstVatFiledMoment(undefined)).toBeNull();
  });
});
