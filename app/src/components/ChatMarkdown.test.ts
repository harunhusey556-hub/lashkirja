import { describe, expect, it } from "vitest";
import { parseBlocks } from "./ChatMarkdown";

describe("parseBlocks", () => {
  it("splits paragraphs, bullets, and numbered lines", () => {
    expect(parseBlocks("Hei\n\n- yksi\n- kaksi\n\n1. a\n2) b")).toEqual([
      { type: "p", text: "Hei" },
      {
        type: "ul",
        items: [
          { text: "yksi", depth: 0 },
          { text: "kaksi", depth: 0 },
        ],
      },
      {
        type: "ol",
        items: [
          { text: "a", depth: 0 },
          { text: "b", depth: 0 },
        ],
      },
    ]);
  });

  it("keeps bold, italic, and code markers for the inline renderer", () => {
    expect(parseBlocks("ALV **24%** ja *kursiivi* sekä `koodi`")).toEqual([
      { type: "p", text: "ALV **24%** ja *kursiivi* sekä `koodi`" },
    ]);
  });

  it("reads headings, fenced code, and a nested bullet", () => {
    expect(parseBlocks("# Otsikko\n\n```\nconst a = 1\n```\n\n- yksi\n  - sisä")).toEqual([
      { type: "h", level: 1, text: "Otsikko" },
      { type: "pre", text: "const a = 1" },
      {
        type: "ul",
        items: [
          { text: "yksi", depth: 0 },
          { text: "sisä", depth: 1 },
        ],
      },
    ]);
  });
});
