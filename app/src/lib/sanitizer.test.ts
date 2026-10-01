import { describe, expect, it } from "vitest";
import { sanitizeText } from "./sanitizer";

describe("sanitizeText keeps ordinary text", () => {
  it("does not treat a lone < as a tag (F61)", () => {
    expect(sanitizeText("a < b")).toBe("a < b");
    expect(sanitizeText("<3")).toBe("<3");
    expect(sanitizeText("5 < 10 ja 3 <= 4")).toBe("5 < 10 ja 3 <= 4");
    expect(sanitizeText("Alle 50 € (<50) ja yli 20 > 10")).toBe("Alle 50 € (<50) ja yli 20 > 10");
    expect(sanitizeText("Hinta < 50 € ja > 20 €")).toBe("Hinta < 50 € ja > 20 €");
    expect(sanitizeText("LT-host Cafe <3 Kukka & Co")).toBe("LT-host Cafe <3 Kukka & Co");
    expect(sanitizeText("x<y and y>z")).toBe("x<y and y>z");
  });

  it("still removes whole tags and comments", () => {
    expect(sanitizeText("<script>alert(1)</script>LT-host Kahvila")).toBe("alert(1)LT-host Kahvila");
    expect(sanitizeText("Hei <b>maailma</b>")).toBe("Hei maailma");
    expect(sanitizeText('<img src="x" onerror="y">Kuva')).toBe("Kuva");
    expect(sanitizeText("a<br/>b")).toBe("ab");
    expect(sanitizeText("a <!-- piilo --> b")).toBe("a  b");
  });

  it("strips control characters, trims, and returns null for nothing", () => {
    expect(sanitizeText("  rivi\u0000yksi\nrivi kaksi  ")).toBe("riviyksi\nrivi kaksi");
    expect(sanitizeText("   ")).toBeNull();
    expect(sanitizeText(null)).toBeNull();
    expect(sanitizeText(undefined)).toBeNull();
    expect(sanitizeText("<b></b>")).toBeNull();
  });
});
