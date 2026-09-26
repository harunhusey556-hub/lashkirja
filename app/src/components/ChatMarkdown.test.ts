import { describe, expect, it } from "vitest";
import { parseBlocks } from "./ChatMarkdown";

describe("parseBlocks", () => {
  it("splits paragraphs, bullets, and numbered lines", () => {
    expect(parseBlocks("Hei\n\n- yksi\n- kaksi\n\n1. a\n2) b")).toEqual([
      { type: "p", text: "Hei" },
      { type: "ul", items: ["yksi", "kaksi"] },
      { type: "ol", items: ["a", "b"] },
    ]);
  });

  it("keeps bold and code markers in the text for the inline renderer", () => {
    expect(parseBlocks("ALV **24%** ja `koodi`")).toEqual([
      { type: "p", text: "ALV **24%** ja `koodi`" },
    ]);
  });
});
