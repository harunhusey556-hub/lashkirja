import { describe, expect, it } from "vitest";
import {
  amountClass,
  amountFitsBesideName,
  dateRowStacks,
  estimatedTextPx,
  finnishLabelClass,
  longIbanClass,
  longNameClass,
} from "./text-layout";

const LONG_NAME = "Ääkkönen Ripsistudio ja Kauneushoitola Oy";
const LONG_IBAN = "FI21 1234 5600 0007 85";
const LARGE_AMOUNT = "12 345 678,90 €";

describe("long text on a phone", () => {
  it("truncates a customer name and keeps the amount on one line", () => {
    expect(longNameClass).toContain("truncate");
    expect(longNameClass).toContain("min-w-0");
    expect(amountClass).toContain("whitespace-nowrap");
    expect(amountClass).toContain("shrink-0");
    expect(LONG_NAME.length).toBeGreaterThan(20);
  });

  it("lets an IBAN and a Finnish label wrap instead of overlapping", () => {
    expect(longIbanClass).toContain("break-all");
    expect(longIbanClass).toContain("min-w-0");
    expect(finnishLabelClass).toContain("break-words");
    expect(LONG_IBAN).toContain("FI21");
  });

  it("stacks date fields on compact and large phone widths", () => {
    expect(dateRowStacks(390)).toBe(true);
    expect(dateRowStacks(430)).toBe(true);
    expect(dateRowStacks(844)).toBe(false);
  });

  it("keeps a large euro amount beside a truncated name at 390 and 430, including larger text", () => {
    for (const width of [390, 430]) {
      expect(amountFitsBesideName(width, 32, LARGE_AMOUNT, 1)).toBe(true);
      expect(amountFitsBesideName(width, 32, LARGE_AMOUNT, 1.4)).toBe(true);
    }
    expect(estimatedTextPx(LARGE_AMOUNT, 1.4)).toBeGreaterThan(estimatedTextPx(LARGE_AMOUNT, 1));
  });
});
