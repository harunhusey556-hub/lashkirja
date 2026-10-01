import { describe, expect, it } from "vitest";
import { pdfMoney, sanitizePdfText, winAnsiCanDraw } from "./pdf-text";

/** What the built-in Helvetica can draw: the worst case the helper must survive. */
const sanitize = (value: string) => sanitizePdfText(value, winAnsiCanDraw);

describe("sanitizePdfText", () => {
  it("leaves Finnish and Latin-1 text untouched", () => {
    const text = "\u00c4iti \u00d6ljy, \u00dcnl\u00fc \u00c7i\u00e7ek, \u00d3lafur \u00de\u00f3r \u00e4 \u00f6 \u00e5 \u20ac";
    expect(sanitize(text)).toBe(text);
  });

  it("maps letters outside WinAnsi to their closest plain form", () => {
    // Lukasz Zolc with Ł, Ż, ł, ć: the Latin-1 o-acute stays.
    expect(sanitize("\u0141ukasz \u017b\u00f3\u0142\u0107")).toBe("Lukasz Z\u00f3lc");
    // Sukru Agaoglu Insaat: S-cedilla, g-breve, I-dot, s-cedilla.
    expect(sanitize("\u015e\u00fckr\u00fc A\u011fao\u011flu \u0130n\u015faat")).toBe(
      "S\u00fckr\u00fc Agaoglu Insaat"
    );
    // o and u with double acute.
    expect(sanitize("K\u0151r\u00f6si Gy\u0171r\u0171")).toBe("Kor\u00f6si Gyuru");
  });

  it("replaces what has no plain form with one question mark per run", () => {
    expect(sanitize("\u0418\u0432\u0430\u043d \u041f\u0435\u0442\u0440\u043e\u0432")).toBe("? ?");
    expect(sanitize("Kahvi \u{1F600}\u{1F600} hyv\u00e4\u00e4")).toBe("Kahvi ? hyv\u00e4\u00e4");
    expect(sanitize("\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd")).toBe("? ?");
  });

  it("strips control characters and turns a tab into a space", () => {
    expect(sanitize("a\tb")).toBe("a b");
    expect(sanitize("ring\u0007bell")).toBe("ringbell");
    expect(sanitize("x\u0000y\u007fz\u0085w")).toBe("xyzw");
  });

  it("keeps line breaks and normalises every kind to a plain newline", () => {
    expect(sanitize("a\r\nb\rc\u2028d\u2029e\nf")).toBe("a\nb\nc\nd\ne\nf");
  });

  it("drops zero-width and bidi control marks without leaving a question mark", () => {
    expect(sanitize("a\u200bb\u200fc\u202ed\u2066e\ufeff")).toBe("abcde");
  });

  it("decomposes compatibility forms instead of losing them", () => {
    expect(sanitize("\ufb01ne \uff21\uff11")).toBe("fine A1");
  });

  it("trusts a font that can draw the character", () => {
    expect(sanitizePdfText("\u0141ukasz \u0418\u0432\u0430\u043d", () => true)).toBe(
      "\u0141ukasz \u0418\u0432\u0430\u043d"
    );
    // ...but still never lets a control character through.
    expect(sanitizePdfText("a\tb\u0007", () => true)).toBe("a b");
  });

  it("copes with empty and null-ish input", () => {
    expect(sanitize("")).toBe("");
    expect(sanitizePdfText(null, winAnsiCanDraw)).toBe("");
    expect(sanitizePdfText(undefined, winAnsiCanDraw)).toBe("");
  });
});

describe("pdfMoney", () => {
  const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, " ");

  it("prints a negative amount with a plain hyphen-minus", () => {
    expect(plain(pdfMoney(-6450))).toBe("-64,50 \u20ac");
    expect(pdfMoney(-6450)).not.toContain("\u2212");
  });

  it("prints no negative zero", () => {
    expect(plain(pdfMoney(-0))).toBe("0,00 \u20ac");
  });

  it("groups thousands with a character the PDF font has", () => {
    expect(plain(pdfMoney(359_250))).toBe("3 592,50 \u20ac");
    expect(pdfMoney(359_250)).not.toMatch(/\u202f/);
  });
});
